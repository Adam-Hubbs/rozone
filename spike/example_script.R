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

stop("Sourcing this file should never be needed for docs to work")
