#' Mutate with a default
#'
#' @inheritParams dplyr::mutate
#' @param extra A value added to every new column.
mutate_plus <- function(.data, ..., extra = 1) {
  dplyr::mutate(.data, ...)
}

mutate_plus(mtcars, x = 1)
