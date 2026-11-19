#' A shape
#'
#' @slot name A label.
setClass("Shape", representation("VIRTUAL", name = "character"))

#' A circle
#'
#' @slot r The radius.
Circle <- setClass("Circle", contains = "Shape", slots = c(r = "numeric"))

#' Area
#' @param shape A shape.
setGeneric("area", function(shape) standardGeneric("area"))

setMethod("area", "Circle", function(shape) pi * shape@¦r^2)
setMethod("show", signature(object = "Circle"), function(object) cat(object@na¦me))
setValidity("Circle", function(object) object@¦r >= 0)

c1 <- Circle(r = 1, name = "unit")
c1@¦r
c1@na¦me
c2 <- new("Circle", r = 2)
c2@¦r
c1@miss¦ing

library(S7)

#' A dog
#'
#' @prop name What it is called.
#' @prop age How old it is.
Dog := new_class(properties = list(name = class_character, age = class_double))

#' Make a noise
#' @param x An animal.
speak := new_generic("x")

method(speak, Dog) <- function(x) cat(x@na¦me, "says woof\n")

d <- Dog(name = "Rex", age = 3)
d@a¦ge
function(d) d@a¦ge
