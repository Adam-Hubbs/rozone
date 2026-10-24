test_that("only function literal assignments are evaluated", {
  withr::local_options(rozone_hit = NULL)
  exprs <- parse(
    text = c(
      "f <- function(x = options(rozone_hit = 'default')) options(rozone_hit = 'body')",
      "g = function() 2",
      "h <<- function() 3",
      "k <- \\(z) z",
      "options(rozone_hit = 'toplevel')",
      "y <- options(rozone_hit = 'assign')"
    ),
    keep.source = FALSE
  )
  env <- sandbox_functions(exprs)
  expect_setequal(ls(env), c("f", "g", "h", "k"))
  expect_null(getOption("rozone_hit"))
})

test_that("odd assignment targets and calls never error", {
  exprs <- parse(
    text = c(
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
      "`my fun` <- function() 1",
      "'quoted' <- function() 1",
      "(function() 1)()"
    ),
    keep.source = FALSE
  )
  expect_no_error(env <- sandbox_functions(exprs))
  expect_setequal(ls(env), c("my fun", "quoted"))
})

test_that("is_function_assignment accepts only the literal shape", {
  is_fa <- \(code)
    is_function_assignment(parse(text = code, keep.source = FALSE)[[1]])
  expect_true(is_fa("f <- function() 1"))
  expect_true(is_fa("f = function() 1"))
  expect_false(is_fa("f <- g()"))
  expect_false(is_fa("f()(x) <- 1"))
  expect_false(is_fa("f"))
  expect_false(is_fa("1"))
})

test_that("building never runs default arguments, bodies or top-level code", {
  withr::local_options(rozone_hit = NULL)
  text <- c(
    "options(rozone_hit = 'toplevel')",
    "#' Doc",
    "#' @param x X.",
    "f <- function(x = options(rozone_hit = 'default')) options(rozone_hit = 'body')",
    "stop('script code must not run')"
  ) |>
    paste(collapse = "\n")
  result <- build_text(text)
  expect_null(getOption("rozone_hit"))
  expect_equal(first_topic(result)$name, "f")
})
