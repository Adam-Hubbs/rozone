local_sentinel_dir <- function(.env = parent.frame()) {
  dir <- withr::local_tempdir(.local_envir = .env)
  withr::local_envvar(ROZONE_SENTINEL_DIR = dir, .local_envir = .env)
  dir
}

expect_no_sentinels <- function(dir) {
  expect_identical(list.files(dir), character())
}

# Each vector goes through bare roxygen2 in its own process. If one stops
# creating its sentinel the matching hostile case below proves nothing.
test_that("every code-execution vector really fires in unprotected roxygen2", {
  skip_if_not_installed("knitr")
  touch <- "file.create(file.path(Sys.getenv('ROZONE_SENTINEL_DIR'), '%s'))"
  vectors <- list(
    inline = sprintf("#' Text `r %s`.", sprintf(touch, "inline")),
    fence = c("#' ```{r}", paste("#'", sprintf(touch, "fence")), "#' ```"),
    eval = sprintf("#' @eval %s; ''", sprintf(touch, "eval"))
  )
  code <- c(
    "text <- readLines(commandArgs(TRUE)[[1]]) |> paste(collapse = '\\n')",
    "env <- new.env(parent = baseenv())",
    "blocks <- roxygen2::parse_text(text, env = env)",
    "r <- roxygen2::roclet_process(roxygen2::rd_roclet(), blocks, env, base_path = commandArgs(TRUE)[[2]])",
    "for (t in r) format(t)"
  ) |>
    paste(collapse = "\n")
  purrr::iwalk(vectors, \(lines, name) {
    dir <- local_sentinel_dir()
    path <- withr::local_tempfile(fileext = ".R")
    writeLines(
      c("#' Title", "#'", lines, "#' @md", "f <- function() NULL"),
      path
    )
    child_r(code, c(path, fixtures_dir), env = c(ROZONE_SENTINEL_DIR = dir))
    expect_true(length(list.files(dir)) > 0L, label = name)
  })
})

test_that("each vector alone is neutralised by the sidecar", {
  touch <- "file.create(file.path(Sys.getenv('ROZONE_SENTINEL_DIR'), 'x'))"
  vectors <- list(
    inline = sprintf("#' Text `r %s`.", touch),
    fence = c("#' ```{r}", paste("#'", touch), "#' ```"),
    eval = sprintf("#' @eval %s; ''", touch),
    evalrd = sprintf("#' @evalRd %s; ''", touch),
    evalns = sprintf("#' @evalNamespace %s; ''", touch),
    includermd = paste(
      "#' @includeRmd",
      file.path(fixtures_dir, "sentinel.Rmd")
    )
  )
  purrr::iwalk(vectors, \(lines, name) {
    dir <- local_sentinel_dir()
    text <- paste(
      c("#' Title", "#'", lines, "#' @md", "f <- function() NULL"),
      collapse = "\n"
    )
    result <- build_text(text)
    expect_identical(list.files(dir), character(), label = name)
    expect_identical(first_topic(result)$title, "Title", label = name)
  })
})

test_that("Rd containing \\Sexpr is kept out of the installed package", {
  dir <- local_sentinel_dir()
  lib_root <- withr::local_tempdir()
  text <- c(
    "#' Bad",
    "#' \\doi{10.1/x\"); file.create(file.path(Sys.getenv('ROZONE_SENTINEL_DIR'), 'doi')); (\"}",
    "bad <- function() NULL",
    "",
    "#' Good",
    "good <- function() NULL"
  ) |>
    paste(collapse = "\n")
  result <- build_files(
    file_spec("/a.R", text),
    install = TRUE,
    lib_root = lib_root
  )
  expect_identical(installed_topics(result$lib_dir), "good.Rd")
  expect_match(purrr::map_chr(result$errors, "message"), "Sexpr", all = FALSE)
  expect_no_sentinels(dir)
})

test_that("evaluation entry points in roxygen2 are disabled even without stripping", {
  dir <- local_sentinel_dir()
  install_eval_guards()
  text <- c(
    "#' Title `r file.create(file.path(Sys.getenv('ROZONE_SENTINEL_DIR'), 'guard_inline'))`",
    "#' @md",
    "f <- function() NULL"
  ) |>
    paste(collapse = "\n")
  env <- sandbox_functions(parse(text = text, keep.source = FALSE))
  expect_no_error(roxygen2::parse_text(text, env = env))
  expect_no_sentinels(dir)
  roxy_knit <- get("roxy_knit", envir = asNamespace("roxygen2"))
  expect_error(roxy_knit("`r 1`", new.env(), list()), "disabled")
})

test_that("a doc block before top-level calls does not run them", {
  dir <- local_sentinel_dir()
  text <- c(
    "#' Doc for a call",
    "#' @md",
    "file.create(file.path(Sys.getenv('ROZONE_SENTINEL_DIR'), 'call'))",
    "",
    "#' Doc for a value",
    "#' @md",
    "value <- file.create(file.path(Sys.getenv('ROZONE_SENTINEL_DIR'), 'assign'))",
    "",
    "#' S4 and friends",
    "setClass('Zed', representation(x = 'numeric'))"
  ) |>
    paste(collapse = "\n")
  expect_no_error(build_text(text))
  expect_no_sentinels(dir)
})

test_that("the real process runs none of the hostile fixture", {
  purrr::walk(c(FALSE, TRUE), \(install) {
    dir <- local_sentinel_dir()
    lib_root <- withr::local_tempdir()
    session <- start_sidecar(c(ROZONE_SENTINEL_DIR = dir))
    read_message(session)
    response <- send_request(
      session,
      1,
      "build",
      build_params(
        list(file_spec(file.path(dir, "hostile.R"), hostile_text())),
        install = install,
        lib_root = if (install) lib_root
      ),
      timeout = 120
    )
    expect_null(response$error)
    expect_no_sentinels(dir)
    expect_true("survivor" %in% unlist(response$result$topics))
  })
})
