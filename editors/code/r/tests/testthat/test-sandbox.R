test_that("only function literal assignments are documented, nothing is evaluated", {
  withr::local_options(rozone_hit = NULL)
  text <- c(
    "options(rozone_hit = 'toplevel')",
    "#' Doc",
    "#' @param x X.",
    "f <- function(x = options(rozone_hit = 'default')) options(rozone_hit = 'body')",
    "",
    "#' Value",
    "y <- options(rozone_hit = 'assign')",
    "stop('script code must not run')"
  ) |>
    paste(collapse = "\n")
  result <- build_text(text)
  expect_null(getOption("rozone_hit"))
  expect_identical(first_topic(result)$name, "f")
  expect_identical(result$errors, list())
})

test_that("odd assignment targets and calls never break a build", {
  text <- c(
    "f()(x) <- 1",
    "names(x) <- 'a'",
    "x[[1]] <- 2",
    "x$y <- function() 1",
    "'str'",
    "NULL",
    "1 + 2",
    "if (a) b",
    "a <- b <- function() 1",
    "pkg::fn <- function() 1",
    "(function() 1)()",
    "",
    "#' Odd names",
    "`my fun` <- function() 1"
  ) |>
    paste(collapse = "\n")
  result <- build_text(text)
  expect_identical(result$errors, list())
  expect_identical(first_topic(result)$name, "my fun")
})
