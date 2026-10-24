testthat::local_edition(3, .env = testthat::teardown_env())

sidecar_path <- normalizePath(test_path("..", "..", "sidecar.R"))
fixtures_dir <- normalizePath(test_path("..", "fixtures"))

# Sourcing (not running) the script defines every function in this env.
sys.source(sidecar_path, envir = environment())

rscript <- file.path(R.home("bin"), "Rscript")

file_spec <- function(path, text, hash = paste0("hash-", path)) {
  list(path = path, hash = hash, text = text)
}

quiet <- function(code) {
  con <- file(nullfile(), "w")
  sink(con, type = "message")
  on.exit({
    sink(type = "message")
    close(con)
  })
  code
}

build_files <- function(
  ...,
  state = new_state(),
  install = FALSE,
  lib_root = NULL
) {
  params <- list(files = list(...), install = install, lib_root = lib_root)
  quiet(handle_build(params, state))
}

build_text <- function(text, path = "/t.R") {
  build_files(file_spec(path, text))
}

first_topic <- function(result, file = 1L, topic = 1L) {
  result$manifest$files[[file]]$topics[[topic]]
}

# Round trip through the real emitter so tests see exactly what the client sees.
through_json <- function(x) {
  line <- utils::capture.output(emit(x))
  jsonlite::fromJSON(line, simplifyVector = FALSE)
}

request_line <- function(id, method, params = NULL) {
  jsonlite::toJSON(
    list(id = id, method = method, params = params),
    auto_unbox = TRUE,
    null = "null"
  ) |>
    as.character()
}

hostile_text <- function() {
  readLines(file.path(fixtures_dir, "hostile.R"), warn = FALSE) |>
    gsub(
      pattern = "__FIXTURE_DIR__",
      replacement = fixtures_dir,
      fixed = TRUE
    ) |>
    paste(collapse = "\n")
}

example_script_text <- function() {
  paste(
    c(
      "#' Weighted mean of a column",
      "#'",
      "#' Computes a weighted mean, dropping `NA` pairs.",
      "#'",
      "#' @param x A numeric vector.",
      "#' @param w Weights, the same length as `x`.",
      "#' @returns A length-1 double.",
      "#' @examples",
      "#' wmean(1:3, c(1, 1, 2))",
      "wmean <- function(x, w = rep(1, length(x))) {",
      "  sum(x * w) / sum(w)",
      "}"
    ),
    collapse = "\n"
  )
}

# A running sidecar process ----------------------------------------------------

start_sidecar <- function(
  env = character(),
  stdin = "|",
  .local_envir = parent.frame()
) {
  proc <- processx::process$new(
    rscript,
    c("--no-init-file", sidecar_path),
    stdin = stdin,
    stdout = "|",
    stderr = "|",
    env = c("current", env),
    cleanup_tree = TRUE
  )
  withr::defer(proc$kill(), envir = .local_envir)
  session <- new.env()
  session$proc <- proc
  session$buffer <- character()
  session$seen <- character()
  session
}

read_line <- function(session, timeout = 60) {
  deadline <- Sys.time() + timeout
  while (length(session$buffer) == 0L) {
    if (Sys.time() > deadline) {
      stop("timed out waiting for sidecar output", call. = FALSE)
    }
    session$proc$poll_io(500)
    session$buffer <- c(session$buffer, session$proc$read_output_lines())
    if (length(session$buffer) == 0L && !session$proc$is_alive()) {
      session$buffer <- session$proc$read_output_lines()
      if (length(session$buffer) == 0L) {
        return(NULL)
      }
    }
  }
  line <- session$buffer[[1L]]
  session$buffer <- session$buffer[-1L]
  session$seen <- c(session$seen, line)
  line
}

read_message <- function(session, timeout = 60) {
  line <- read_line(session, timeout)
  if (is.null(line)) NULL else jsonlite::fromJSON(line, simplifyVector = FALSE)
}

send_line <- function(session, line) {
  session$proc$write_input(paste0(line, "\n"))
}

send_request <- function(session, id, method, params = NULL, timeout = 60) {
  send_line(session, request_line(id, method, params))
  read_message(session, timeout)
}

wait_for_exit <- function(session, timeout = 30) {
  session$proc$wait(timeout * 1000)
  session$proc$get_exit_status()
}

build_params <- function(files, install = FALSE, lib_root = NULL) {
  list(files = files, install = install, lib_root = lib_root)
}

# Run R code in a fresh child session and return its stdout lines.
child_r <- function(code, args = character(), env = character()) {
  out <- processx::run(
    rscript,
    c("--no-init-file", "-e", code, args),
    env = c("current", env),
    error_on_status = FALSE
  )
  strsplit(out$stdout, "\n", fixed = TRUE)[[1L]]
}
