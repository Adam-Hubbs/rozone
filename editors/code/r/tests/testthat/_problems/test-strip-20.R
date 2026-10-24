# Extracted from test-strip.R:20

# test -------------------------------------------------------------------------
lines <- c("#' Use `mean(x)` and `r` as a name, or `rnorm`.")
expect_identical(strip_r_code(lines), lines)
