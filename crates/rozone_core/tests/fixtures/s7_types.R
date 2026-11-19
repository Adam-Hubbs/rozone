library(S7)

#' A number
#'
#' Integers or doubles.
Number <- new_union(class_integer, class_double)

#' Text or nothing
OptionalText <- class_character | NULL

#' A measurement
#'
#' @prop value The amount.
#' @prop unit What it is measured in.
Measure := new_class(properties = list(value = Number, unit = OptionalText))

#' Median of a measurement
#'
#' Registers a method for the stats generic.
median_ext <- new_external_generic("stats", "median", "x")

#' Summarise
summary_ext := new_external_generic("base", dispatch_args = "object")

#' The median value
method(median_ext, Measure) <- function(x, na.rm = FALSE, ...) x@value

m <- Measure(value = 1L, unit = "cm")
Num¦ber
Optional¦Text
median_e¦xt
summary_e¦xt
median_ext(¦)
x <- a | b
