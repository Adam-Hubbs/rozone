library(dplyr)

#' Weighted mean of a column
#'
#' Computes a weighted mean, dropping `NA` pairs.
#'
#' @param x A numeric vector.
#' @param w Weights, the same length as `x`.
#' @returns A length-1 double.
#' @examples
#' wmean(1:3, c(1, 1, 2))
wmean <- function(x, w = rep(1, length(x))) {
  keep <- !is.na(x) & !is.na(w)
  sum(x[keep] * w[keep]) / sum(w[keep])
}

#' Summarise a data frame column with [wmean()]
#'
#' @inheritParams wmean
#' @param data A data frame.
#' @param col <[`data-masked`][dplyr::dplyr_data_masking]> Column to summarise.
summarise_wmean <- function(data, col, w) {
  summarise(data, wmean = wmean({{ col }}, w))
}

undocumented <- function(a) a

wm¦ean(1:3)
wmean(1:3, ¦)
wmean(1:3¦, 2)
map(xs, w¦mean)
w¦mean <- 1
undoc¦umented(1)
wmean(x = ¦1, w = 2)
summarise_wmean(df, ¦col, ¦)
summarise_wmean(df, wmean(¦))
base::wm¦ean(1)
obj$wm¦ean(1)
wmean(w¦ = 2)
# wm¦ean in a comment
"wm¦ean in a string"
wmean(rep(1, ¦))
wmean (¦1)
