# Extracted from test-strip.R:129

# test -------------------------------------------------------------------------
lines <- c(
    "#' @examples",
    "#' f()",
    "#' @examplesIf TRUE",
    "#' @evaluate no",
    "#' @templates no"
  )
expect_identical(strip_r_code(lines), lines[1:3])
