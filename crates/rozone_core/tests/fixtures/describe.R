#' Area of a shape
#'
#' Computes the area.
#'
#' @param shape A shape.
#' @param ... Extra.
area <- function(shape, ...) UseMethod("area")

#' @describeIn area Area of a circle
#' @param r Radius.
area_circle <- function(shape, r) NULL

#' @describeIn area
area_nodesc <- function(shape) NULL

#' @describeIn missing_parent Orphan
orphan <- function(x) NULL

area_circle(¦)
area_circle(1, ¦)
