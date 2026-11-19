library(S7)

#' An animal
#'
#' @prop name What it is called.
#' @prop age How old it is, in years.
Animal := new_class(
  properties = list(
    name = class_character,
    age = new_property(class_double, default = 0)
  ),
  abstract = TRUE
)

#' A dog
#'
#' @param name The dog's name.
#' @prop good Whether it is a good dog.
Dog <- new_class("Dog",
  parent = Animal,
  properties = list(good = new_property(class_logical, default = TRUE))
)

#' A range
#'
#' @param x Values to span.
#' @prop start,end The bounds.
Range := new_class(
  properties = list(start = class_double, end = class_double),
  constructor = function(x) new_object(S7_object(), start = min(x), end = max(x))
)

#' Make a noise
#'
#' @param x An animal.
#' @param ... Passed on to methods.
speak := new_generic("x")

#' Describe something
#'
#' @param x The thing.
#' @param style How to describe it.
describe <- new_generic("describe", "x", function(x, style = "short", ...) S7_dispatch())

#' Dogs bark
method(speak, Dog) <- function(x, ...) cat("Woof\n")

method(speak, Animal) <- function(x, ...) cat("...\n")

d <- D¦og(¦name = "Rex", good = TRUE)
spe¦ak(d, ¦)
desc¦ribe(d, st¦)
Ran¦ge(¦1:10)
