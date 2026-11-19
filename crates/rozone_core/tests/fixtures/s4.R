#' A shape
#'
#' The parent of every shape.
#'
#' @slot name A label for the shape.
setClass("Shape", representation("VIRTUAL", name = "character"))

#' A circle
#'
#' @slot r The radius.
#' @export
Circle <- setClass(
  "Circle",
  contains = "Shape",
  slots = c(r = "numeric"),
  prototype = list(r = 1)
)

#' Area of a shape
#'
#' @param shape A shape.
#' @param ... Unused.
#' @returns A number.
setGeneric("area", function(shape, ...) standardGeneric("area"))

#' Area of a circle
setMethod("area", "Circle", function(shape, ...) pi * shape@r^2)

#' @describeIn area Area of anything else
setMethod("area", signature("ANY"), function(shape, ...) NA_real_)

setGeneric("perimeter", function(shape) standardGeneric("perimeter"))

#' Perimeter of a circle
setMethod("perimeter", "Circle", function(shape) 2 * pi * shape@r)

c1 <- Ci¦rcle(r = 2, ¦name = "unit")
ar¦ea(c1, ¦)
perim¦eter(c1)
new("Circle", r = 3)
