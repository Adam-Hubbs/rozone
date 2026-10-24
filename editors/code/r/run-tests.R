args <- commandArgs(trailingOnly = FALSE)
script <- sub("^--file=", "", args[startsWith(args, "--file=")])
root <- dirname(normalizePath(script))

Sys.setenv(NOT_CRAN = "true")
results <- testthat::test_dir(
  file.path(root, "tests", "testthat"),
  reporter = "summary",
  stop_on_failure = FALSE,
  stop_on_warning = FALSE
)

failed <- results |>
  as.data.frame() |>
  subset(failed > 0L | error)
if (nrow(failed) > 0L) {
  quit(save = "no", status = 1L)
}
