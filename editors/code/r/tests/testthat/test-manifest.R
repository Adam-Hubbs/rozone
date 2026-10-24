test_that("result and manifest have exactly the contract field names", {
  result <- build_text(example_script_text()) |> through_json()
  expect_named(
    result,
    c("manifest", "lib_dir", "topics", "cache_hits", "errors"),
    ignore.order = TRUE
  )
  expect_identical(result$manifest$version, 1L)
  file <- result$manifest$files[[1]]
  expect_named(file, c("path", "content_hash", "topics"), ignore.order = TRUE)
  expect_identical(file$path, "/t.R")
  expect_identical(file$content_hash, "hash-/t.R")
  expect_named(
    file$topics[[1]],
    c(
      "name",
      "aliases",
      "title",
      "description_md",
      "details_md",
      "params",
      "returns_md",
      "sections",
      "examples",
      "inherited_from"
    ),
    ignore.order = TRUE
  )
  expect_null(result$lib_dir)
  expect_identical(result$topics, list("wmean"))
})

test_that("single-element arrays stay arrays and absent fields are null", {
  topic <- build_text(example_script_text()) |>
    through_json() |>
    _$manifest$files[[1]]$topics[[1]]
  expect_identical(topic$aliases, list("wmean"))
  expect_identical(topic$inherited_from, list())
  expect_true("details_md" %in% names(topic))
  expect_null(topic$details_md)
  expect_identical(topic$sections, list())
})

test_that("the example script yields the expected topic", {
  topic <- first_topic(build_text(example_script_text()))
  expect_identical(topic$name, "wmean")
  expect_identical(as.character(topic$aliases), "wmean")
  expect_identical(topic$title, "Weighted mean of a column")
  expect_identical(
    topic$description_md,
    "Computes a weighted mean, dropping `NA` pairs."
  )
  expect_identical(topic$returns_md, "A length-1 double.")
  expect_identical(topic$examples, "wmean(1:3, c(1, 1, 2))")
  expect_identical(
    purrr::map_chr(topic$params, "name"),
    c("x", "w")
  )
  expect_snapshot(cat(jsonlite::toJSON(
    topic,
    auto_unbox = TRUE,
    null = "null",
    pretty = TRUE
  )))
})

test_that("params follow the formal order, not the tag order", {
  text <- c(
    "#' Title",
    "#' @param c Third.",
    "#' @param a First.",
    "#' @param extra Not a formal.",
    "#' @param b Second.",
    "f <- function(a, b, c) NULL"
  ) |>
    paste(collapse = "\n")
  topic <- first_topic(build_text(text))
  expect_identical(
    purrr::map_chr(topic$params, "name"),
    c("a", "b", "c", "extra")
  )
})

test_that("multi-name params split into one entry per name with shared md", {
  text <- c(
    "#' Title",
    "#' @param x,y The coordinates, see [wmean()].",
    "f <- function(x, y) NULL"
  ) |>
    paste(collapse = "\n")
  params <- first_topic(build_text(text))$params
  expect_identical(purrr::map_chr(params, "name"), c("x", "y"))
  expect_identical(
    purrr::map_chr(params, "md"),
    rep("The coordinates, see [wmean()].", 2)
  )
})

test_that("multi-line markdown, sections, details and links are kept as source", {
  text <- c(
    "#' Title",
    "#'",
    "#' Description with [wmean()] and [dplyr::mutate()].",
    "#'",
    "#' Details paragraph.",
    "#'",
    "#' Second paragraph.",
    "#' @param x First line",
    "#'   second line.",
    "#' @section Notes:",
    "#' A note with `code`.",
    "#'",
    "#' @section Warnings: Inline body.",
    "#' @return A value.",
    "f <- function(x) NULL"
  ) |>
    paste(collapse = "\n")
  topic <- first_topic(build_text(text))
  expect_identical(
    topic$description_md,
    "Description with [wmean()] and [dplyr::mutate()]."
  )
  expect_identical(topic$details_md, "Details paragraph.\n\nSecond paragraph.")
  expect_match(topic$params[[1]]$md, "First line\n.*second line.")
  expect_identical(
    purrr::map_chr(topic$sections, "title"),
    c("Notes", "Warnings")
  )
  expect_identical(topic$sections[[1]]$md, "A note with `code`.")
  expect_identical(topic$sections[[2]]$md, "Inline body.")
  expect_identical(topic$returns_md, "A value.")
})

test_that("aliases come from the Rd topic", {
  text <- c(
    "#' Title",
    "#' @aliases other_name",
    "f <- function() NULL",
    "",
    "#' Another",
    "#' @rdname f",
    "g <- function() NULL"
  ) |>
    paste(collapse = "\n")
  result <- build_text(text)
  topic <- first_topic(result)
  expect_setequal(topic$aliases, c("f", "other_name", "g"))
  expect_length(result$manifest$files[[1]]$topics, 1L)
  expect_identical(as.character(result$topics), c("f", "g", "other_name"))
})

test_that("functions without docs produce no topics", {
  result <- build_text("f <- function() NULL\n")
  expect_length(result$manifest$files[[1]]$topics, 0L)
  expect_identical(as.character(result$topics), character())
})

test_that("local @inheritParams keeps roxygen markdown source", {
  text <- c(
    "#' Source",
    "#' @param w Weights, see [wmean()].",
    "wmean <- function(w) NULL",
    "",
    "#' User",
    "#' @inheritParams wmean",
    "user <- function(w) NULL"
  ) |>
    paste(collapse = "\n")
  topic <- first_topic(build_text(text), topic = 2L)
  expect_identical(topic$params[[1]]$name, "w")
  expect_identical(topic$params[[1]]$md, "Weights, see [wmean()].")
  expect_identical(as.character(topic$inherited_from), character())
})

test_that("@inheritParams resolves across workspace files", {
  src <- c("#' Source", "#' @param w Weights.", "wmean <- function(w) NULL")
  user <- c("#' User", "#' @inheritParams wmean", "user <- function(w) NULL")
  result <- build_files(
    file_spec("/b/user.R", paste(user, collapse = "\n")),
    file_spec("/a/src.R", paste(src, collapse = "\n"))
  )
  topic <- first_topic(result, file = 1L)
  expect_identical(topic$name, "user")
  expect_identical(topic$params[[1]]$md, "Weights.")
})

test_that("@inheritParams resolves transitively", {
  text <- c(
    "#' A",
    "#' @param w Weights.",
    "a <- function(w) NULL",
    "",
    "#' B",
    "#' @inheritParams a",
    "b <- function(w) NULL",
    "",
    "#' C",
    "#' @inheritParams b",
    "c <- function(w) NULL"
  ) |>
    paste(collapse = "\n")
  topic <- first_topic(build_text(text), topic = 3L)
  expect_identical(topic$params[[1]]$md, "Weights.")
})

test_that("cyclic @inheritParams does not loop", {
  text <- c(
    "#' A",
    "#' @inheritParams b",
    "a <- function(w) NULL",
    "",
    "#' B",
    "#' @inheritParams a",
    "b <- function(w) NULL"
  ) |>
    paste(collapse = "\n")
  expect_no_error(build_text(text))
})

test_that("@inheritParams from another package is resolved from its Rd", {
  skip_if_not_installed("dplyr")
  text <- c(
    "#' Wrapper",
    "#' @inheritParams dplyr::mutate",
    "#' @param extra Own param.",
    "f <- function(.data, ..., extra) NULL"
  ) |>
    paste(collapse = "\n")
  topic <- first_topic(build_text(text))
  expect_identical(as.character(topic$inherited_from), "dplyr::mutate")
  expect_identical(
    purrr::map_chr(topic$params, "name"),
    c(".data", "...", "extra")
  )
  expect_match(topic$params[[1]]$md, "^A data frame")
  expect_false(any(grepl(
    "\\\\(code|link|emph)",
    purrr::map_chr(topic$params, "md")
  )))
  expect_match(topic$params[[2]]$md, "- ", fixed = TRUE)
  expect_identical(topic$params[[3]]$md, "Own param.")
})

test_that("@inherit and @inheritDotParams pull in converted Rd", {
  skip_if_not_installed("dplyr")
  text <- c(
    "#' Wrapper",
    "#' @inherit dplyr::mutate return",
    "#' @inheritDotParams dplyr::mutate",
    "f <- function(...) NULL"
  ) |>
    paste(collapse = "\n")
  topic <- first_topic(build_text(text))
  expect_match(topic$returns_md, "^An object of the same type as `.data`")
  expect_match(topic$params[[1]]$md, ".keep", fixed = TRUE)
  expect_identical(as.character(topic$inherited_from), "dplyr::mutate")
})

test_that("inheriting from an uninstalled package degrades gracefully", {
  text <- c(
    "#' Wrapper",
    "#' @inheritParams notapkg.zzz::thing",
    "#' @param x Own.",
    "f <- function(x, y) NULL"
  ) |>
    paste(collapse = "\n")
  result <- build_text(text)
  topic <- first_topic(result)
  expect_identical(purrr::map_chr(topic$params, "name"), "x")
  expect_length(result$manifest$files, 1L)
  messages <- purrr::map_chr(result$errors, "message")
  expect_match(messages, "notapkg.zzz", all = FALSE)
})

test_that("non-ASCII text survives the JSON round trip", {
  text <- c(
    "#' Café 日本語 title",
    "#'",
    "#' Emoji \U0001F600 and \"quotes\" \\ backslash.",
    "f <- function() NULL"
  ) |>
    paste(collapse = "\n")
  topic <- build_text(text) |>
    through_json() |>
    _$manifest$files[[1]]$topics[[1]]
  expect_identical(topic$title, "Café 日本語 title")
  expect_identical(
    topic$description_md,
    "Emoji \U0001F600 and \"quotes\" \\ backslash."
  )
})

test_that("CRLF line endings are handled", {
  text <- "#' Title\r\n#' @param x X.\r\nf <- function(x) NULL\r\n"
  topic <- first_topic(build_text(text))
  expect_identical(topic$title, "Title")
  expect_identical(topic$params[[1]]$md, "X.")
})
