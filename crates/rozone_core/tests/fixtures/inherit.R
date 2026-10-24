#' Base function
#'
#' @param data The data.
#' @param n Number of rows.
base_fn <- function(data, n) NULL

#' Middle
#' @inheritParams base_fn
#' @param extra Extra.
middle <- function(data, n, extra) NULL

#' Top
#' @inheritParams middle
top <- function(data, extra, n, other) NULL

#' Cycle A
#' @inheritParams cycle_b
#' @param a_own Own.
cycle_a <- function(a_own, shared) NULL

#' Cycle B
#' @inheritParams cycle_a
#' @param shared Shared doc.
cycle_b <- function(shared, a_own) NULL

#' Self
#' @inheritParams self_ref
self_ref <- function(x) NULL

#' From dplyr
#' @inheritParams dplyr::mutate
#' @inheritParams base_fn
#' @param .data Mine.
from_pkg <- function(.data, ..., .by = NULL, data) NULL

#' Inherit all
#' @inherit base_fn
inherit_all <- function(data, n) NULL

#' Inherit some
#' @inherit base_fn params
#' @inherit middle title
inherit_some <- function(data) NULL

#' Dots
#' @inheritDotParams base_fn
#' @inheritSection base_fn Notes
dots_fn <- function(...) NULL

#' @inherit stats::sd
pkg_inherit <- function(x) NULL

#' @inheritParams not_defined_anywhere
unknown_source <- function(x) NULL

top(¦)
top(1, ¦)
