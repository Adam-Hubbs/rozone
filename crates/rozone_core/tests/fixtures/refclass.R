#' A bank account
#'
#' Tracks a balance.
#'
#' @field owner Who holds it.
#' @field balance The amount held.
Account <- setRefClass("Account",
  fields = list(owner = "character", balance = "numeric"),
  methods = list(
    deposit = function(x) {
      "Add money to the account."
      balance <<- balance + x
      invisible(.self)
    },
    #' @description Take money out.
    #' @param x How much.
    withdraw = function(x) {
      if (x > balance) stop("insufficient funds")
      balance <<- bal¦ance - x
      depo¦sit(0)
      .self$depo¦sit(0)
    }
  )
)

Account$methods(
  report = function() {
    "Print the balance."
    cat(owner, "has", bala¦nce, "\n")
  }
)

#' A savings account
#'
#' @field rate The interest rate.
Savings <- setRefClass("Savings",
  contains = "Account",
  fields = list(rate = "numeric"),
  methods = list(
    initialize = function(..., rate = 0.01) {
      "Open an account with an interest rate."
      callSuper(..., rate = rate)
    }
  )
)

a <- Accou¦nt(¦owner = "Al", balance = 10)
a$depo¦sit(¦5)
a$rep¦ort()
a$bal¦ance
b <- Account$ne¦w(¦)
s <- Savings(¦)
s$withd¦raw(1)
