#' A person
#'
#' Someone with a name.
#'
#' @field name Their name.
Person <- R6::R6Class("Person",
  public = list(
    name = NULL,

    #' @description Make a person.
    #' @param name Their name.
    #' @param greeting How they say hello.
    initialize = function(name, greeting = "Hi") {
      self$name <- name
      private$greeting <- greeting
    },

    #' @description Say hello.
    #' @param to Who to greet.
    #' @returns The greeting, invisibly.
    greet = function(to = "you") {
      private$say(to)
      invisible(self)
    }
  ),
  private = list(
    greeting = NULL,
    #' @description Print a line.
    say = function(to) cat(private$greeting, to, "\n")
  ),
  active = list(
    #' @field shout The name in capitals.
    shout = function() toupper(self$name)
  )
)

#' A student
#'
#' @field school Where they study.
Student <- R6Class("Student",
  inherit = Person,
  public = list(
    school = NULL,

    #' @description Say hello and name the school.
    greet = function(to = "you") {
      super$gr¦eet(to)
      cat("I go to", self$sc¦hool, "\n")
    }
  )
)

p <- Pers¦on$ne¦w("Al", ¦)
p$gre¦et(¦)
p$na¦me
p$sh¦out
s <- Student$new(¦)
s$gre¦et()

helper <- function(p) p$gre¦et()
