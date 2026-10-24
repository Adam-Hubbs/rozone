# Extracted from test-sandbox.R:16

# test -------------------------------------------------------------------------
withr::local_options(rozone_hit = NULL)
exprs <- parse(
    text = c(
      "f <- function(x = options(rozone_hit = 'default')) options(rozone_hit = 'body')",
      "g = function() 2",
      "h <<- function() 3",
      "function() 4 -> k",
      "options(rozone_hit = 'toplevel')",
      "y <- options(rozone_hit = 'assign')",
      "\\(z) z -> lam"
    ),
    keep.source = FALSE
  )
env <- sandbox_functions(exprs)
expect_setequal(ls(env), c("f", "g", "h", "k", "lam"))
