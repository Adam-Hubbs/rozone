#' Scale a vector
#'
#' Multiplies every element by a factor.
#'
#' @param x A numeric vector.
#' @param factor Multiplier applied to `x`.
#' @returns A numeric vector.
scale_by <- function(x, factor = 2) {
  x * factor
}
