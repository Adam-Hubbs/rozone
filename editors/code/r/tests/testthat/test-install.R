wmean_text <- function(version = "v1") {
  c(
    paste("#' Weighted mean", version),
    "#'",
    "#' Computes a weighted mean.",
    "#' @param x A numeric vector.",
    "wmean <- function(x) NULL"
  ) |>
    paste(collapse = "\n")
}

install_build <- function(lib_root, text, state, hash = text) {
  build_files(
    file_spec("/t.R", text, hash = hash),
    install = TRUE,
    lib_root = lib_root,
    state = state
  )
}

test_that("each install goes to a fresh increasing generation and old ones go", {
  lib_root <- withr::local_tempdir()
  state <- new_state()
  dirs <- c("v1", "v2", "v3") |>
    purrr::map_chr(\(v) install_build(lib_root, wmean_text(v), state)$lib_dir)
  expect_identical(basename(dirs), c("lib-1", "lib-2", "lib-3"))
  expect_identical(list.files(lib_root), "lib-3")
})

test_that("an unchanged workspace reuses the installed library", {
  lib_root <- withr::local_tempdir()
  state <- new_state()
  first <- install_build(lib_root, wmean_text(), state)
  second <- install_build(lib_root, wmean_text(), state)
  expect_identical(first$lib_dir, second$lib_dir)
  expect_identical(list.files(lib_root), "lib-1")
})

test_that("a new process continues after the highest existing generation", {
  lib_root <- withr::local_tempdir()
  dir.create(file.path(lib_root, "lib-7"))
  result <- install_build(lib_root, wmean_text(), new_state())
  expect_identical(basename(result$lib_dir), "lib-8")
  expect_identical(list.files(lib_root), "lib-8")
})

test_that("the installed package is loadable and exposes help topics", {
  lib_root <- withr::local_tempdir()
  result <- install_build(lib_root, wmean_text(), new_state())
  out <- child_r(
    paste(
      "lib <- commandArgs(TRUE)[[1]]",
      "loadNamespace('rozone.docs', lib.loc = lib)",
      "h <- utils::help('wmean', package = 'rozone.docs', lib.loc = lib)",
      "cat('FOUND:', length(h), '\\n')",
      sep = "\n"
    ),
    result$lib_dir
  )
  expect_true("FOUND: 1 " %in% out)
})

test_that("consecutive installs load cleanly in one long-lived R session", {
  lib_root <- withr::local_tempdir()
  child <- processx::process$new(
    rscript,
    c(
      "--no-init-file",
      "-e",
      paste(
        "con <- file('stdin', 'r')",
        "repeat {",
        "  lib <- readLines(con, 1)",
        "  if (!length(lib)) break",
        "  if (isNamespaceLoaded('rozone.docs')) unloadNamespace('rozone.docs')",
        "  loadNamespace('rozone.docs', lib.loc = lib)",
        "  h <- utils::help('wmean', package = 'rozone.docs', lib.loc = lib)",
        "  tf <- tempfile()",
        "  tools::Rd2txt(utils:::.getHelpFile(h), out = tf, options = list(underline_titles = FALSE))",
        "  cat('RESULT:', paste(readLines(tf), collapse = ' '), '\\n')",
        "}",
        sep = "\n"
      )
    ),
    stdin = "|",
    stdout = "|",
    stderr = "|"
  )
  withr::defer(child$kill())

  state <- new_state()
  results <- c("v1", "v2", "v3") |>
    purrr::map_chr(\(v) {
      lib <- install_build(lib_root, wmean_text(v), state)$lib_dir
      child$write_input(paste0(lib, "\n"))
      repeat {
        child$poll_io(30000)
        out <- child$read_output_lines()
        hit <- grep("^RESULT:", out, value = TRUE)
        if (length(hit) > 0L) {
          return(hit[[1L]])
        }
        if (!child$is_alive()) {
          stop("child died: ", child$read_all_error(), call. = FALSE)
        }
      }
    })
  expect_match(results[[1]], "Weighted mean v1", fixed = TRUE)
  expect_match(results[[2]], "Weighted mean v2", fixed = TRUE)
  expect_match(results[[3]], "Weighted mean v3", fixed = TRUE)
  expect_false(any(grepl("corrupt", results)))
})

test_that("install output never reaches stdout", {
  lib_root <- withr::local_tempdir()
  sink_file <- withr::local_tempfile()
  result <- withr::with_output_sink(
    sink_file,
    quiet(
      handle_build(
        list(
          files = list(file_spec("/t.R", wmean_text())),
          install = TRUE,
          lib_root = lib_root
        ),
        new_state()
      )
    )
  )
  expect_identical(readLines(sink_file), character())
  expect_false(is.null(result$lib_dir))
})

test_that("an install failure is reported and keeps the manifest", {
  state <- new_state()
  not_a_dir <- withr::local_tempfile()
  writeLines("file", not_a_dir)
  result <- build_files(
    file_spec("/t.R", wmean_text()),
    install = TRUE,
    lib_root = file.path(not_a_dir, "libs"),
    state = state
  ) |>
    suppressWarnings()
  expect_null(result$lib_dir)
  expect_length(result$manifest$files, 1L)
  expect_gt(length(result$errors), 0L)
})
