# Every vector writes a distinct sentinel file into ROZONE_SENTINEL_DIR when
# its code runs. __FIXTURE_DIR__ is replaced by the tests with the directory
# that holds the sentinel Rmd, template and example files.

file.create(file.path(Sys.getenv("ROZONE_SENTINEL_DIR"), "toplevel"))

#' Hostile function
#'
#' Inline code: `r file.create(file.path(Sys.getenv("ROZONE_SENTINEL_DIR"), "inline"))`.
#' Padded inline: ` r file.create(file.path(Sys.getenv("ROZONE_SENTINEL_DIR"), "inline_padded"))` here.
#' Double ticks: ``r file.create(file.path(Sys.getenv("ROZONE_SENTINEL_DIR"), "inline_double"))`` here.
#' Multi-line: `r
#' file.create(file.path(Sys.getenv("ROZONE_SENTINEL_DIR"), "inline_multiline"))` here.
#' Rd output: `Rd file.create(file.path(Sys.getenv("ROZONE_SENTINEL_DIR"), "inline_rd"))` here.
#'
#' ```{r}
#' file.create(file.path(Sys.getenv("ROZONE_SENTINEL_DIR"), "fence"))
#' ```
#'
#' ~~~{r}
#' file.create(file.path(Sys.getenv("ROZONE_SENTINEL_DIR"), "fence_tilde"))
#' ~~~
#'
#' ````{r, echo = FALSE}
#' file.create(file.path(Sys.getenv("ROZONE_SENTINEL_DIR"), "fence_options"))
#' ````
#'
#' - item with a nested fence
#'
#'   ```{r}
#'   file.create(file.path(Sys.getenv("ROZONE_SENTINEL_DIR"), "fence_nested"))
#'   ```
#'
#' ```
#' plain fence, tag-like lines inside still start tags for roxygen2
#' @evalRd file.create(file.path(Sys.getenv("ROZONE_SENTINEL_DIR"), "evalrd_in_fence")); ""
#' ```
#'
#' \doi{10.1/x"); file.create(file.path(Sys.getenv("ROZONE_SENTINEL_DIR"), "doi_macro")); ("}
#' \Sexpr[results=rd,stage=build]{file.create(file.path(Sys.getenv("ROZONE_SENTINEL_DIR"), "sexpr_text")); ""}
#'
#' @param x Default argument below must never run.
#' @eval file.create(file.path(Sys.getenv("ROZONE_SENTINEL_DIR"), "eval")); "#' @md"
#' @evalRd file.create(file.path(Sys.getenv("ROZONE_SENTINEL_DIR"), "evalrd")); ""
#' @evalNamespace file.create(file.path(Sys.getenv("ROZONE_SENTINEL_DIR"), "evalns")); ""
#' @includeRmd __FIXTURE_DIR__/sentinel.Rmd
#' @template sentinel_template
#' @example __FIXTURE_DIR__/sentinel_example.R
#' @examplesIf file.create(file.path(Sys.getenv("ROZONE_SENTINEL_DIR"), "examplesif"))
#' hostile(1)
#' @rawRd \Sexpr[results=rd,stage=build]{file.create(file.path(Sys.getenv("ROZONE_SENTINEL_DIR"), "rawrd")); ""}
hostile <- function(
  x = file.create(file.path(Sys.getenv("ROZONE_SENTINEL_DIR"), "default_arg"))
) {
  file.create(file.path(Sys.getenv("ROZONE_SENTINEL_DIR"), "body"))
  x
}

#' Documented call that is not an assignment
#' @md
file.create(file.path(Sys.getenv("ROZONE_SENTINEL_DIR"), "call_after_doc"))

#' Documented non-function assignment
#' @md
documented_value <- file.create(file.path(
  Sys.getenv("ROZONE_SENTINEL_DIR"),
  "assign_after_doc"
))

#' Surviving function
#'
#' This one is harmless and must still be documented.
#' @param y A number.
survivor <- function(y) y

stop("top-level script code must never run")
