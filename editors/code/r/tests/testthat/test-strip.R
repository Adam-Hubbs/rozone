test_that("non-roxygen lines are never touched", {
  lines <- c(
    "x <- 1  # `r Sys.time()` in a plain comment",
    "# ```{r}",
    "# @eval stop()",
    "f <- function() NULL"
  )
  expect_identical(strip_r_code(lines), lines)
})

test_that("inline r code is removed in place", {
  expect_identical(
    strip_r_code("#' Today is `r Sys.Date()`."),
    "#' Today is ."
  )
})

test_that("inline code that is not R code survives", {
  lines <- c("#' Use `mean(x)` and `r` as a name, or `rnorm`.")
  expect_identical(strip_r_code(lines), lines)
})

test_that("inline r variants are all removed", {
  strip <- \(x) strip_r_code(paste0("#' ", x))
  expect_identical(strip("a ` r 1+1 ` b"), "#' a  b")
  expect_identical(strip("a ``r 1+1`` b"), "#' a  b")
  expect_identical(strip("a `Rd \\\\code{x}` b"), "#' a  b")
  expect_identical(strip("`r 1` and `r 2`"), "#'  and ")
})

test_that("code spans pair like CommonMark so prose between spans is kept", {
  expect_identical(
    strip_r_code("#' `x` r `y` stays"),
    "#' `x` r `y` stays"
  )
})

test_that("an inline span may continue over lines within one tag", {
  lines <- c("#' Before `r", "#' Sys.time()` after", "#' @param x kept")
  expect_identical(
    strip_r_code(lines),
    c("#' Before  after", "#' @param x kept")
  )
})

test_that("a span never crosses a tag boundary", {
  lines <- c("#' @param x opens `r", "#' @param y closes` here")
  expect_identical(strip_r_code(lines), lines)
})

test_that("fenced r chunks are removed including options and longer fences", {
  lines <- c(
    "#' Keep",
    "#' ```{r}",
    "#' stop('a')",
    "#' ```",
    "#' also keep",
    "#' ````{r, echo = FALSE}",
    "#' stop('b')",
    "#' ````",
    "#' ~~~{r}",
    "#' stop('c')",
    "#' ~~~",
    "#' end"
  )
  expect_identical(strip_r_code(lines), c("#' Keep", "#' also keep", "#' end"))
})

test_that("fences nested in lists and quotes are removed", {
  lines <- c(
    "#' - item",
    "#'",
    "#'   ```{r}",
    "#'   stop()",
    "#'   ```",
    "#' > ```{r}",
    "#' > stop()",
    "#' > ```",
    "#' done"
  )
  expect_identical(strip_r_code(lines), c("#' - item", "#'", "#' done"))
})

test_that("plain fences are kept verbatim, backticks inside are not parsed", {
  lines <- c(
    "#' ```r",
    "#' x <- `r 1`",
    "#' ```",
    "#' `r 2` after"
  )
  expect_identical(strip_r_code(lines), c(lines[1:3], "#'  after"))
})

test_that("a fence with an unterminated eval chunk ends with the block", {
  lines <- c("#' ```{r}", "#' stop()", "f <- 1", "#' next block")
  expect_identical(strip_r_code(lines), c("f <- 1", "#' next block"))
})

test_that("eval tags and their continuation lines are removed", {
  lines <- c(
    "#' Title",
    "#' @eval c(",
    "#'   '#'  one',",
    "#'   'two')",
    "#' @param x kept",
    "#' @evalRd stop()",
    "#' @evalNamespace stop()",
    "#' @includeRmd foo.Rmd",
    "#' @template tmpl",
    "#' @templateVar a b",
    "#' @example file.R",
    "#' @Sexpr stop()",
    "#' @return kept too"
  )
  expect_identical(
    strip_r_code(lines),
    c("#' Title", "#' @param x kept", "#' @return kept too")
  )
})

test_that("similar-looking tags are not removed", {
  lines <- c(
    "#' @examples",
    "#' f()",
    "#' @examplesIf TRUE",
    "#' @evaluate no",
    "#' @templates no"
  )
  expect_identical(strip_r_code(lines), lines)
})

test_that("tag lines inside a plain fence still count as tags", {
  lines <- c("#' ```", "#' @evalRd stop()", "#' ```", "#' text")
  expect_false(any(grepl("evalRd", strip_r_code(lines))))
})

test_that("indented and ##' comment prefixes are recognised", {
  expect_identical(strip_r_code("  #' @eval stop()"), character())
  expect_identical(strip_r_code("##' @eval stop()"), character())
})
