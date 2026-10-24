#' Equals
eq = function(a) NULL

#' Super
sup <<- function(a) NULL

#' Right arrow
(function(a) NULL) -> arrow

#' Parenthesised
paren <- (function(a) NULL)

#' Not top level
outer <- function() {
  #' Inner doc
  inner <- function(z) NULL
  inner(¦1)
}

if (TRUE) {
  #' In if
  in_if <- function(q) NULL
}

#' Not a function
value <- 42

#' Unparenthesised right arrow is a function body
function(a) NULL -> not_a_def

eq(¦)
sup(¦)
arrow(¦)
paren(¦)
in_if(¦)
