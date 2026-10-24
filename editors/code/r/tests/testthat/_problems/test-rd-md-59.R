# Extracted from test-rd-md.R:59

# test -------------------------------------------------------------------------
cases <- list(
    code = c("Use \\code{x} here", "Use `x` here"),
    code_with_link = c("\\code{\\link{foo}}", "`foo`"),
    code_with_emph = c("\\code{\\emph{x}}", "`x`"),
    code_with_backtick = c("\\code{a`b}", "`` a`b ``"),
    link_pkg_topic = c("\\link[pkg:topic]{some text}", "some text"),
    link_bare = c("see \\link{mutate}", "see mutate"),
    link_alias = c("\\link[=foo]{foo()}", "foo()"),
    link_in_code = c(
      "\\code{\\link[dplyr:group_by]{group_by()}}",
      "`group_by()`"
    ),
    emph = c("an \\emph{important} word", "an *important* word"),
    strong = c("a \\strong{bold} word", "a **bold** word"),
    bold = c("a \\bold{bold} word", "a **bold** word"),
    href = c("\\href{https://x.org/a}{X site}", "[X site](https://x.org/a)"),
    url = c("\\url{https://x.org}", "<https://x.org>"),
    verb = c("\\verb{a b}", "`a b`"),
    squote = c("\\sQuote{hi}", "\u2018hi\u2019"),
    dquote = c("\\dQuote{hi}", "\u201chi\u201d"),
    dots = c("pass \\dots on", "pass ... on"),
    ldots = c("pass \\ldots on", "pass ... on"),
    R = c("the \\R language", "the R language"),
    escaped_percent = c("100\\% sure", "100% sure"),
    escaped_backslash = c("a \\\\ b", "a \\ b"),
    escaped_braces = c("\\{x\\}", "{x}"),
    cr = c("one\\cr two", "one\n two"),
    eqn = c("\\eqn{x^2}", "`x^2`"),
    eqn_two_args = c("\\eqn{x^2}{x squared}", "`x^2`"),
    itemize = c(
      "\\itemize{\n\\item first\n\\item second\n}",
      "- first\n- second"
    ),
    enumerate = c(
      "\\enumerate{\n\\item first\n\\item second\n}",
      "1. first\n2. second"
    ),
    describe = c(
      "\\describe{\n\\item{\\code{a}}{The a.}\n\\item{b}{The b.}\n}",
      "- **`a`**: The a.\n- **b**: The b."
    ),
    nested_list = c(
      "\\itemize{\\item outer\\itemize{\\item inner}}",
      "- outer\n\n  - inner"
    ),
    preformatted = c(
      "\\preformatted{x <- 1\ny <- 2}",
      "```\nx <- 1\ny <- 2\n```"
    ),
    html_only_dropped = c("\\if{html}{\\out{<div>}}text", "text"),
    text_branch_kept = c("\\ifelse{html}{H}{T}", "T"),
    section = c("\\subsection{Why}{Because.}", "**Why**\n\nBecause."),
    unknown_command_keeps_content = c("\\wibble{kept}", "kept"),
    pkg = c("\\pkg{dplyr}", "`dplyr`"),
    doi = c("\\doi{10.1/x}", "[doi:10.1/x](https://doi.org/10.1/x)")
  )
purrr::iwalk(cases, \(case, nm) {
    expect_identical(rd_to_md(case[[1]]), case[[2]], label = nm)
  })
