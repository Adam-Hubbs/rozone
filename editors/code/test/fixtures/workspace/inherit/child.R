#' Scale then shift
#'
#' @inheritParams scale_by
#' @param shift Amount added after scaling.
scale_shift <- function(x, factor, shift = 0) {
  scale_by(x, factor) + shift
}

scale_shift(1:3, 2, 1)
