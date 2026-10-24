#' Inline `r Sys.time()` code
#'
#' Today is `r format(Sys.Date())`, really.
#'
#' ```{r}
#' system("touch /tmp/pwned")
#' ```
#'
#' After the fence.
#'
#' ```{r, echo = FALSE}
#' x <- 1
#' ```
#'
#' ````{r eval=TRUE}
#' y
#' ````
#'
#' ```r
#' kept <- "plain r fence"
#' ```
#'
#' @eval stop("boom")
#'   still_eval()
#' @param x Documented `r 1 + 1` here.
#' @evalRd paste0("\\value{", "x", "}")
#' @evalNamespace "export(f)"
#' @includeRmd README.Rmd
#' @returns Kept.
#' @export
hostile <- function(x) NULL

#' @eval everything()
no_docs_left <- function(a) NULL

#' Unterminated fence
#'
#' ```{r}
#' system("x")
#' @param a Lost with the fence.
unterminated <- function(a) NULL
