doc_text <- function(title, fn = "f") {
  paste0("#' ", title, "\n", fn, " <- function() NULL\n")
}

test_that("unchanged files are served from the cache", {
  state <- new_state()
  spec <- file_spec("/a.R", doc_text("One"))
  first <- build_files(spec, state = state)
  second <- build_files(spec, state = state)
  expect_identical(first$cache_hits, 0L)
  expect_identical(second$cache_hits, 1L)
  expect_identical(first$manifest, second$manifest)
})

test_that("a changed hash rebuilds only that file", {
  state <- new_state()
  a <- file_spec("/a.R", doc_text("One", "a"))
  b <- file_spec("/b.R", doc_text("Two", "b"))
  build_files(a, b, state = state)
  b2 <- file_spec("/b.R", doc_text("Two edited", "b"), hash = "new")
  result <- build_files(a, b2, state = state)
  expect_identical(result$cache_hits, 1L)
  expect_identical(first_topic(result, file = 2L)$title, "Two edited")
  expect_identical(result$manifest$files[[2]]$content_hash, "new")
})

test_that("files missing from the request are evicted", {
  state <- new_state()
  a <- file_spec("/a.R", doc_text("One", "a"))
  b <- file_spec("/b.R", doc_text("Two", "b"))
  build_files(a, b, state = state)
  expect_setequal(names(state$cache), c("/a.R", "/b.R"))
  build_files(a, state = state)
  expect_named(state$cache, "/a.R")
  result <- build_files(a, b, state = state)
  expect_identical(result$cache_hits, 1L)
})

test_that("text is read from disk when not supplied", {
  path <- withr::local_tempfile(fileext = ".R")
  writeLines(c("#' From disk", "f <- function() NULL"), path)
  spec <- list(path = path, hash = "h1")
  result <- build_files(spec)
  expect_identical(first_topic(result)$title, "From disk")

  writeLines(c("#' Edited on disk", "f <- function() NULL"), path)
  expect_identical(build_files(list(path = path, hash = "h2"))$cache_hits, 0L)
  state <- new_state()
  build_files(spec, state = state)
  stale <- build_files(spec, state = state)
  expect_identical(stale$cache_hits, 1L)
})

test_that("an unreadable file is reported and the build still succeeds", {
  good <- file_spec("/good.R", doc_text("Good"))
  missing <- list(path = file.path(tempdir(), "does-not-exist.R"), hash = "x")
  result <- suppressWarnings(build_files(good, missing))
  expect_length(result$manifest$files, 1L)
  expect_identical(result$errors[[1]]$path, missing$path)
})

test_that("an unparseable file is an error entry and is omitted", {
  good <- file_spec("/good.R", doc_text("Good"))
  bad <- file_spec("/bad.R", "#' Doc\nf <- function( {\n")
  result <- build_files(bad, good)
  expect_identical(purrr::map_chr(result$manifest$files, "path"), "/good.R")
  expect_length(result$errors, 1L)
  expect_identical(result$errors[[1]]$path, "/bad.R")
  expect_true(nzchar(result$errors[[1]]$message))
})

test_that("errors are cached and repeated while the file stays broken", {
  state <- new_state()
  bad <- file_spec("/bad.R", "f <- function( {")
  build_files(bad, state = state)
  again <- build_files(bad, state = state)
  expect_identical(again$cache_hits, 1L)
  expect_length(again$errors, 1L)
})

test_that("topics defined in two files: the smallest path wins the Rd", {
  state <- new_state()
  b <- file_spec("/b.R", doc_text("From b", "dup"))
  a <- file_spec("/a.R", doc_text("From a", "dup"))
  c <- file_spec("/c.R", doc_text("From c", "only_c"))
  result <- build_files(b, c, a, state = state)

  titles <- result$manifest$files |>
    purrr::map(\(f) f$topics[[1]]$title) |>
    purrr::set_names(purrr::map_chr(result$manifest$files, "path"))
  expect_identical(titles[["/a.R"]], "From a")
  expect_identical(titles[["/b.R"]], "From b")

  ok <- purrr::keep(state$cache, \(e) is.null(e$error))
  winners <- winning_rd(ok)
  expect_setequal(names(winners), c("dup.Rd", "only_c.Rd"))
  expect_match(winners[["dup.Rd"]]$text, "From a", fixed = TRUE)
  expect_false(grepl("From b", winners[["dup.Rd"]]$text, fixed = TRUE))
  expect_identical(as.character(result$topics), c("dup", "only_c"))
})

test_that("request order does not change which duplicate wins", {
  a <- file_spec("/a.R", doc_text("From a", "dup"))
  b <- file_spec("/b.R", doc_text("From b", "dup"))
  state <- new_state()
  build_files(b, a, state = state)
  winners <- winning_rd(state$cache)
  expect_match(winners[["dup.Rd"]]$text, "From a", fixed = TRUE)
})

test_that("install requires lib_root", {
  expect_error(
    handle_build(list(files = list(), install = TRUE), new_state()),
    "lib_root"
  )
})
