# rozone sidecar: a long-lived R process that turns roxygen comments in plain
# R scripts into a manifest (and optionally an installed `rozone.docs`
# package). Protocol: JSON lines on stdin/stdout, see docs/contracts.md section 4.
#
# Runtime requirements are roxygen2 and jsonlite only (purrr comes with
# roxygen2). The script never evaluates script bodies, default arguments or
# any R code embedded in roxygen comments.
#
# Test hook: ROZONE_SIDECAR_REQUIRE overrides the comma-separated list of
# packages the hello handshake requires (default "roxygen2,jsonlite").

protocol_version <- 1L

# JSON without jsonlite (the hello must work when jsonlite is missing) ---------

json_escape <- function(x) {
  x |>
    gsub(pattern = "\\", replacement = "\\\\", fixed = TRUE) |>
    gsub(pattern = "\"", replacement = "\\\"", fixed = TRUE) |>
    gsub(pattern = "\n", replacement = "\\n", fixed = TRUE) |>
    gsub(pattern = "\r", replacement = "\\r", fixed = TRUE) |>
    gsub(pattern = "\t", replacement = "\\t", fixed = TRUE)
}

json_string <- function(x) {
  if (length(x) == 0L) character() else paste0("\"", json_escape(x), "\"")
}

write_protocol_line <- function(line) {
  writeLines(enc2utf8(line), stdout(), useBytes = TRUE)
  flush(stdout())
}

package_version_or_na <- function(pkg) {
  tryCatch(
    as.character(utils::packageVersion(pkg)),
    error = \(e) NA_character_
  )
}

hello_line <- function(required) {
  versions <- required |>
    purrr::set_names() |>
    purrr::map_chr(package_version_or_na)
  missing <- names(versions)[is.na(versions)]
  found <- versions[!is.na(versions)]
  r_version <- paste(R.version$major, R.version$minor, sep = ".")
  packages <- found |>
    purrr::imap_chr(\(v, p) paste0(json_string(p), ":", json_string(v))) |>
    paste(collapse = ",")
  missing_json <- missing |> json_string() |> paste(collapse = ",")
  list(
    line = paste0(
      "{\"event\":\"hello\",\"protocol\":",
      protocol_version,
      ",\"r_version\":",
      json_string(r_version),
      ",\"packages\":{",
      packages,
      "},\"missing\":[",
      missing_json,
      "],\"ok\":",
      if (length(missing) == 0L) "true" else "false",
      "}"
    ),
    ok = length(missing) == 0L
  )
}

required_packages <- function() {
  Sys.getenv("ROZONE_SIDECAR_REQUIRE", "roxygen2,jsonlite") |>
    strsplit(",", fixed = TRUE) |>
    purrr::chuck(1L) |>
    trimws() |>
    purrr::keep(nzchar)
}

emit <- function(x) {
  jsonlite::toJSON(
    x,
    auto_unbox = TRUE,
    null = "null",
    na = "null",
    digits = NA
  ) |>
    as.character() |>
    write_protocol_line()
}

log_msg <- function(...) {
  cat("[rozone] ", ..., "\n", sep = "", file = stderr())
}

# Stripping R code out of roxygen comments --------------------------------------

roxygen_prefix <- "^\\s*#+'"

eval_tag_pattern <- paste0(
  "^\\s*@(eval(Rd|Namespace)?|includeRmd|template(Var)?|example|Sexpr)\\b"
)

# Inline code in markdown is evaluated when its text starts with `r ` (or
# `Rd ` for \Sexpr output). This mirrors CommonMark's code span pairing: a run
# of N backticks closes at the next run of exactly N backticks.
strip_inline_code <- function(text) {
  runs <- gregexpr("`+", text)[[1]]
  if (runs[[1]] == -1L) {
    return(text)
  }
  starts <- as.integer(runs)
  lens <- attr(runs, "match.length")
  cuts <- list()
  i <- 1L
  while (i <= length(starts)) {
    j <- which(lens == lens[[i]] & seq_along(lens) > i)[1L]
    if (is.na(j)) {
      i <- i + 1L
      next
    }
    content <- substr(text, starts[[i]] + lens[[i]], starts[[j]] - 1L)
    if (grepl("^\\s*(r|Rd)\\s", content)) {
      cuts <- c(cuts, list(c(starts[[i]], starts[[j]] + lens[[j]] - 1L)))
    }
    i <- j + 1L
  }
  purrr::reduce(
    rev(cuts),
    \(acc, cut)
      paste0(
        substr(acc, 1L, cut[[1]] - 1L),
        substr(acc, cut[[2]] + 1L, nchar(acc))
      ),
    .init = text
  )
}

fence_pattern <- "^[\\s>]*(?:[-*+]\\s+|\\d+[.)]\\s+)*(`{3,}|~{3,})(.*)$"

# Returns, per line, one of "plain" (not roxygen), "drop", "verbatim" (inside a
# non-evaluated fenced code block) or "text".
classify_roxygen_lines <- function(lines) {
  is_roxy <- grepl(roxygen_prefix, lines)
  body <- sub("^\\s*#+'\\s?", "", lines)
  starts_tag <- is_roxy & grepl("^\\s*@", body)
  starts_eval <- is_roxy & grepl(eval_tag_pattern, body, perl = TRUE)
  fence <- regmatches(body, regexec(fence_pattern, body, perl = TRUE))
  is_fence <- is_roxy & lengths(fence) > 0L
  fence_info <- purrr::map_chr(
    fence,
    \(m) if (length(m) > 0L) trimws(m[[3]]) else ""
  )
  opens_eval_fence <- is_fence & startsWith(fence_info, "{")

  modes <- purrr::accumulate(
    seq_along(lines),
    \(prev, i) {
      # roxygen2 splits tags line by line without knowing about fences, so a
      # tag line always ends any fence state.
      if (!is_roxy[[i]]) {
        "keep"
      } else if (starts_eval[[i]] || (prev == "eval" && !starts_tag[[i]])) {
        "eval"
      } else if (starts_tag[[i]]) {
        "keep"
      } else if (prev == "efence") {
        if (is_fence[[i]]) "keep" else "efence"
      } else if (prev == "pfence") {
        if (is_fence[[i]]) "keep" else "pfence"
      } else if (opens_eval_fence[[i]]) {
        "efence"
      } else if (is_fence[[i]]) {
        "pfence"
      } else {
        "keep"
      }
    },
    .init = "keep"
  )
  before <- modes[-length(modes)]
  after <- modes[-1L]

  classify <- function(i) {
    if (!is_roxy[[i]]) {
      "plain"
    } else if (after[[i]] %in% c("eval", "efence") || before[[i]] == "efence") {
      "drop"
    } else if (after[[i]] == "pfence" || before[[i]] == "pfence") {
      "verbatim"
    } else {
      "text"
    }
  }
  list(
    kind = purrr::map_chr(seq_along(lines), classify),
    body = body,
    starts_tag = starts_tag
  )
}

strip_r_code <- function(lines) {
  info <- classify_roxygen_lines(lines)
  kept <- info$kind != "drop"
  lines <- lines[kept]
  kind <- info$kind[kept]
  body <- info$body[kept]
  if (length(lines) == 0L) {
    return(lines)
  }

  # Inline code spans can only span lines within one tag's text.
  is_text <- kind == "text"
  continues <- is_text &
    c(FALSE, is_text[-length(is_text)]) &
    !info$starts_tag[kept]
  group <- cumsum(!continues)

  split(seq_along(lines), group) |>
    unname() |>
    purrr::map(\(idx) {
      if (kind[[idx[[1L]]]] != "text") {
        return(lines[idx])
      }
      original <- paste(body[idx], collapse = "\n")
      stripped <- strip_inline_code(original)
      if (identical(stripped, original)) {
        lines[idx]
      } else {
        paste0("#' ", strsplit(stripped, "\n", fixed = TRUE)[[1L]])
      }
    }) |>
    purrr::list_c()
}

# roxygen2 only enables markdown via DESCRIPTION or a per-block @md tag, and
# scripts have no DESCRIPTION.
with_markdown_tags <- function(lines) {
  is_roxy <- grepl(roxygen_prefix, lines)
  block_end <- is_roxy & !c(is_roxy[-1L], FALSE)
  position <- c(seq_along(lines), which(block_end) + 0.5)
  c(lines, rep("#' @md", sum(block_end)))[order(position)]
}

# Sandbox ------------------------------------------------------------------------

is_function_assignment <- function(expr) {
  is.call(expr) &&
    length(expr) == 3L &&
    is.name(expr[[1L]]) &&
    as.character(expr[[1L]]) %in% c("<-", "=", "<<-") &&
    (is.name(expr[[2L]]) ||
      (is.character(expr[[2L]]) && length(expr[[2L]]) == 1L)) &&
    is.call(expr[[3L]]) &&
    identical(expr[[3L]][[1L]], as.name("function"))
}

# Evaluating a `function(...)` literal only creates a closure; neither the body
# nor default arguments run, so this is safe for arbitrary scripts.
sandbox_functions <- function(exprs) {
  env <- new.env(parent = baseenv())
  exprs |>
    purrr::keep(is_function_assignment) |>
    purrr::walk(
      \(e) assign(as.character(e[[2L]]), eval(e[[3L]], env), envir = env)
    )
  env
}

# Defence in depth: whatever slips past strip_r_code(), roxygen2 must not be
# able to evaluate code. Evaluated markdown nodes become empty text and every
# other evaluating entry point fails.
eval_guards <- list(
  eval_code_node = \(node, env) "",
  roxy_knit = \(...)
    stop("rozone: knitr evaluation is disabled", call. = FALSE),
  roxy_eval = \(...)
    stop("rozone: roxygen evaluation is disabled", call. = FALSE),
  template_eval = \(...) stop("rozone: templates are disabled", call. = FALSE),
  rmd_eval_rd = \(...)
    stop("rozone: Rmd evaluation is disabled", call. = FALSE),
  sys_source = \(...) stop("rozone: sourcing is disabled", call. = FALSE)
)

required_guards <- c("eval_code_node", "roxy_knit", "roxy_eval")

install_eval_guards <- function() {
  ns <- asNamespace("roxygen2")
  absent <- setdiff(required_guards, ls(ns, all.names = TRUE))
  if (length(absent) > 0L) {
    stop(
      "unsupported roxygen2 version, cannot disable evaluation of: ",
      paste(absent, collapse = ", "),
      call. = FALSE
    )
  }
  eval_guards |>
    purrr::keep_at(ls(ns, all.names = TRUE)) |>
    purrr::iwalk(\(fn, nm) {
      unlockBinding(nm, ns)
      assign(nm, fn, envir = ns)
      lockBinding(nm, ns)
    })
  invisible(TRUE)
}

# Rd to markdown -------------------------------------------------------------------

rd_zero_arg <- c("dots", "ldots", "R", "cr", "tab", "sspace", "bsl")
rd_arity <- c(
  href = 2L,
  `if` = 2L,
  ifelse = 3L,
  section = 2L,
  subsection = 2L,
  enc = 2L,
  method = 2L,
  S3method = 2L,
  S4method = 2L,
  tabular = 2L
)
rd_code_like <- c(
  "code",
  "samp",
  "verb",
  "command",
  "file",
  "env",
  "option",
  "kbd",
  "var",
  "pkg",
  "eqn",
  "deqn",
  "linkS4class",
  "CRANpkg"
)

rd_parse_group <- function(ch, i) {
  rd_parse_seq(ch, i + 1L, in_group = TRUE)
}

rd_next_is <- function(ch, i, what) i <= length(ch) && ch[[i]] == what

rd_parse_command <- function(ch, i) {
  end <- i
  while (end <= length(ch) && grepl("[A-Za-z0-9]", ch[[end]])) {
    end <- end + 1L
  }
  name <- paste(ch[i:(end - 1L)], collapse = "")
  i <- end
  opt <- NULL
  if (name == "link" && rd_next_is(ch, i, "[")) {
    close <- i
    while (close <= length(ch) && ch[[close]] != "]") {
      close <- close + 1L
    }
    opt <- paste(ch[(i + 1L):(close - 1L)], collapse = "")
    i <- close + 1L
  }
  arity <- command_arity(name, ch, i)
  args <- list()
  while (length(args) < arity && rd_next_is(ch, i, "{")) {
    group <- rd_parse_group(ch, i)
    args <- c(args, list(group$nodes))
    i <- group$pos
  }
  list(node = list(name = name, opt = opt, args = args), pos = i)
}

command_arity <- function(name, ch, i) {
  if (name %in% rd_zero_arg) {
    0L
  } else if (name == "item") {
    if (rd_next_is(ch, i, "{")) 2L else 0L
  } else if (name %in% c("eqn", "deqn")) {
    2L
  } else if (name %in% names(rd_arity)) {
    rd_arity[[name]]
  } else {
    1L
  }
}

rd_parse_seq <- function(ch, i = 1L, in_group = FALSE) {
  nodes <- list()
  buf <- character()
  flush <- function() {
    if (length(buf) > 0L) {
      nodes <<- c(nodes, list(paste(buf, collapse = "")))
      buf <<- character()
    }
  }
  while (i <= length(ch)) {
    c1 <- ch[[i]]
    if (c1 == "}" && in_group) {
      flush()
      return(list(nodes = nodes, pos = i + 1L))
    } else if (c1 == "\\") {
      nxt <- if (i < length(ch)) ch[[i + 1L]] else ""
      if (grepl("^[A-Za-z]$", nxt)) {
        flush()
        parsed <- rd_parse_command(ch, i + 1L)
        nodes <- c(nodes, list(parsed$node))
        i <- parsed$pos
      } else {
        buf <- c(buf, nxt)
        i <- i + 2L
      }
    } else if (c1 == "{") {
      group <- rd_parse_group(ch, i)
      flush()
      nodes <- c(nodes, group$nodes)
      i <- group$pos
    } else {
      buf <- c(buf, c1)
      i <- i + 1L
    }
  }
  flush()
  list(nodes = nodes, pos = i)
}

md_code_span <- function(x) {
  x <- trimws(x)
  if (grepl("`", x, fixed = TRUE)) paste0("`` ", x, " ``") else
    paste0("`", x, "`")
}

rd_render <- function(nodes, plain = FALSE) {
  nodes |>
    purrr::map_chr(\(n) rd_render_node(n, plain)) |>
    paste(collapse = "")
}

rd_list_items <- function(nodes) {
  is_item <- purrr::map_lgl(nodes, \(n) is.list(n) && identical(n$name, "item"))
  group <- cumsum(is_item)
  nodes[group > 0L] |>
    split(group[group > 0L]) |>
    unname()
}

rd_format_item <- function(text, marker) {
  lines <- strsplit(trimws(text), "\n", fixed = TRUE)[[1]]
  if (length(lines) == 0L) {
    return(trimws(marker, "right"))
  }
  indent <- strrep(" ", nchar(marker))
  rest <- character()
  if (length(lines) > 1L) {
    rest <- paste0(indent, lines[-1L]) |>
      sub(pattern = "^ +$", replacement = "")
  }
  paste(c(paste0(marker, lines[[1L]]), rest), collapse = "\n")
}

rd_render_list <- function(nodes, kind, plain) {
  items <- rd_list_items(nodes)
  rendered <- items |>
    purrr::imap_chr(\(group, idx) {
      head <- group[[1L]]
      body_nodes <- group[-1L]
      if (kind == "describe" && length(head$args) == 2L) {
        term <- rd_render(head$args[[1L]], plain)
        desc <- paste0(
          rd_render(head$args[[2L]], plain),
          rd_render(body_nodes, plain)
        )
        rd_format_item(paste0("**", trimws(term), "**: ", trimws(desc)), "- ")
      } else {
        marker <- if (kind == "enumerate") paste0(idx, ". ") else "- "
        rd_format_item(rd_render(body_nodes, plain), marker)
      }
    })
  paste0("\n\n", paste(rendered, collapse = "\n"), "\n\n")
}

rd_render_node <- function(node, plain) {
  if (is.character(node)) {
    return(node)
  }
  a <- node$args
  arg <- \(k) if (length(a) >= k) rd_render(a[[k]], plain) else ""
  verbatim <- \(k) if (length(a) >= k) rd_render(a[[k]], plain = TRUE) else ""
  wrap <- \(mark) if (plain) arg(1L) else paste0(mark, arg(1L), mark)
  code <- \(k = 1L) if (plain) verbatim(k) else md_code_span(verbatim(k))
  switch(
    node$name,
    code = ,
    samp = ,
    verb = ,
    command = ,
    file = ,
    env = ,
    option = ,
    kbd = ,
    var = ,
    pkg = ,
    linkS4class = ,
    CRANpkg = code(),
    eqn = ,
    deqn = code(),
    emph = ,
    dfn = ,
    cite = wrap("*"),
    strong = ,
    bold = wrap("**"),
    acronym = ,
    abbr = ,
    I = ,
    text = arg(1L),
    sQuote = paste0("‘", arg(1L), "’"),
    dQuote = paste0("“", arg(1L), "”"),
    link = arg(1L),
    href = if (plain) arg(2L) else
      paste0("[", arg(2L), "](", trimws(verbatim(1L)), ")"),
    url = paste0("<", trimws(verbatim(1L)), ">"),
    email = paste0("<", trimws(verbatim(1L)), ">"),
    doi = paste0(
      "[doi:",
      trimws(verbatim(1L)),
      "](https://doi.org/",
      trimws(verbatim(1L)),
      ")"
    ),
    dots = ,
    ldots = "...",
    R = "R",
    cr = "\n",
    tab = " | ",
    sspace = " ",
    bsl = "\\",
    itemize = rd_render_list(a[[1L]], "itemize", plain),
    enumerate = rd_render_list(a[[1L]], "enumerate", plain),
    describe = rd_render_list(a[[1L]], "describe", plain),
    item = "\n",
    preformatted = paste0(
      "\n\n```\n",
      trimws(verbatim(1L), "right"),
      "\n```\n\n"
    ),
    section = ,
    subsection = paste0("\n\n**", trimws(arg(1L)), "**\n\n", arg(2L), "\n\n"),
    tabular = paste0("\n\n", arg(2L), "\n\n"),
    `if` = if (grepl("text", verbatim(1L), fixed = TRUE)) arg(2L) else "",
    ifelse = if (grepl("text", verbatim(1L), fixed = TRUE)) arg(2L) else
      arg(3L),
    out = ,
    Sexpr = ,
    figure = ,
    Rdversion = ,
    docType = "",
    enc = arg(2L),
    method = ,
    S3method = ,
    S4method = arg(1L),
    purrr::map_chr(a, \(g) rd_render(g, plain)) |> paste(collapse = "")
  )
}

rd_to_md <- function(rd) {
  rd <- paste(as.character(rd), collapse = "\n")
  if (!nzchar(trimws(rd))) {
    return("")
  }
  rd |>
    strsplit("") |>
    purrr::chuck(1L) |>
    rd_parse_seq() |>
    purrr::chuck("nodes") |>
    rd_render() |>
    gsub(pattern = "[ \t]+\n", replacement = "\n") |>
    gsub(pattern = "\n{3,}", replacement = "\n\n") |>
    trimws()
}

rd_examples_to_text <- function(rd) {
  rd |>
    as.character() |>
    paste(collapse = "\n") |>
    gsub(pattern = "\\\\([%\\\\])", replacement = "\\1") |>
    trimws()
}

# Per-file build --------------------------------------------------------------------

split_lines <- function(text) {
  strsplit(text, "\r\n|\n|\r", perl = TRUE)[[1L]]
}

empty_base_path <- local({
  path <- NULL
  function() {
    if (is.null(path) || !dir.exists(path)) {
      path <<- tempfile("rozone-base")
      dir.create(path)
    }
    path
  }
})

tag_raws <- function(tags, names) {
  tags |>
    purrr::keep(\(t) t$tag %in% names) |>
    purrr::map_chr(\(t) as.character(t$raw))
}

joined_or_null <- function(x) {
  x <- trimws(x[nzchar(trimws(x))])
  if (length(x) == 0L) NULL else paste(x, collapse = "\n\n")
}

split_param_tag <- function(raw) {
  m <- regmatches(raw, regexec("(?s)^\\s*(\\S+)\\s*(.*)$", raw, perl = TRUE))[[
    1L
  ]]
  if (length(m) == 0L) {
    return(NULL)
  }
  names <- m[[2L]] |>
    strsplit(",", fixed = TRUE) |>
    purrr::chuck(1L) |>
    trimws()
  list(names = names[nzchar(names)], md = trimws(m[[3L]]))
}

block_aliases <- function(block) {
  tags <- block$tags
  c(
    block$object$alias,
    tag_raws(tags, "name"),
    tag_raws(tags, "aliases") |> strsplit("\\s+") |> purrr::list_c()
  ) |>
    trimws() |>
    unique()
}

first_token <- function(x) sub("\\s.*$", "", trimws(x))

section_from_raw <- function(raw) {
  parts <- regmatches(raw, regexec("(?s)^([^:]*):(.*)$", raw, perl = TRUE))[[
    1L
  ]]
  if (length(parts) == 0L) {
    list(title = trimws(raw), md = "")
  } else {
    list(title = trimws(parts[[2L]]), md = trimws(parts[[3L]]))
  }
}

is_external <- function(source) grepl("::", source, fixed = TRUE)

topic_record <- function(rd, blocks) {
  aliases <- as.character(rd$get_value("alias"))
  owned <- purrr::keep(blocks, \(b) any(block_aliases(b) %in% aliases))
  tags <- owned |> purrr::map(\(b) b$tags) |> purrr::list_c()
  sources <- tag_raws(
    tags,
    c("inheritParams", "inheritDotParams", "inherit", "inheritSection")
  ) |>
    first_token()
  external <- unique(sources[is_external(sources)])

  local_params <- tags |>
    purrr::keep(\(t) t$tag == "param") |>
    purrr::map(\(t) split_param_tag(as.character(t$raw))) |>
    purrr::compact() |>
    purrr::map(\(p) {
      purrr::map(p$names, \(n) list(name = n, md = p$md, from = "local"))
    }) |>
    purrr::list_c()
  rd_param <- rd$get_value("param")
  rd_params <- if (is.null(rd_param)) {
    list()
  } else {
    rd_param |>
      as.list() |>
      purrr::imap(\(md, nm) {
        nms <- trimws(strsplit(nm, ",", fixed = TRUE)[[1L]])
        purrr::map(
          nms[nzchar(nms)],
          \(n) list(name = n, md = rd_to_md(md), from = "rd")
        )
      }) |>
      purrr::list_c()
  }
  local_names <- purrr::map_chr(local_params, \(p) p$name)
  params <- c(
    local_params,
    purrr::keep(rd_params, \(p) !p$name %in% local_names)
  )
  formals_ <- as.character(rd$get_value("formals"))

  local_title <- tag_raws(tags, "title") |> joined_or_null()
  local_desc <- tag_raws(tags, "description") |> joined_or_null()
  rd_title <- paste(as.character(rd$get_value("title")), collapse = " ")
  rd_desc <- rd$get_value("description") |>
    as.character() |>
    paste(collapse = "\n")
  rd_desc_md <- if (nzchar(rd_desc) && !identical(rd_desc, rd_title))
    rd_to_md(rd_desc) else NULL
  description <- local_desc %||% rd_desc_md

  local_details <- tag_raws(tags, "details") |> joined_or_null()
  rd_details <- rd$get_value("details")
  details <- local_details %||%
    (if (length(rd_details) > 0L) joined_or_null(rd_to_md(rd_details)))

  local_returns <- tag_raws(tags, c("returns", "return")) |> joined_or_null()
  rd_value <- rd$get_value("value")
  returns <- local_returns %||%
    (if (length(rd_value) > 0L) joined_or_null(rd_to_md(rd_value)))

  local_sections <- tags |>
    purrr::keep(\(t) t$tag == "section") |>
    purrr::map(\(t) section_from_raw(as.character(t$raw)))
  rd_sections <- rd$get_value("section")
  inherited_sections <- if (is.null(rd_sections)) {
    list()
  } else {
    purrr::map2(
      rd_sections$title,
      rd_sections$content,
      \(title, content) list(title = trimws(title), md = rd_to_md(content))
    )
  }
  local_titles <- purrr::map_chr(local_sections, \(s) s$title)
  new_sections <- purrr::keep(
    inherited_sections,
    \(s) !s$title %in% local_titles
  )
  sections <- c(local_sections, new_sections)

  ex_tags <- purrr::keep(tags, \(t) t$tag %in% c("examples", "examplesIf"))
  local_examples <- ex_tags |>
    purrr::map_chr(\(t) {
      raw <- as.character(t$raw)
      if (t$tag == "examplesIf") sub("^[^\n]*\n?", "", raw) else raw
    }) |>
    joined_or_null()
  rd_examples <- rd$get_value("examples")
  examples <- local_examples %||%
    (if (length(rd_examples) > 0L)
      joined_or_null(rd_examples_to_text(rd_examples)))

  from_rd <- c(
    is.null(local_desc) && !is.null(rd_desc_md),
    is.null(local_details) && !is.null(details),
    is.null(local_returns) && !is.null(returns),
    length(new_sections) > 0L,
    is.null(local_examples) && !is.null(examples)
  )

  list(
    name = as.character(rd$get_value("name")),
    aliases = aliases,
    title = local_title %||% (if (nzchar(rd_title)) rd_title),
    description_md = description,
    details_md = details,
    params = params,
    returns_md = returns,
    sections = sections,
    examples = examples,
    external = external,
    fields_from_rd = any(from_rd),
    formals = formals_,
    sources = sources[!is_external(sources)]
  )
}

has_sexpr <- function(x) {
  identical(attr(x, "Rd_tag"), "\\Sexpr") ||
    (is.list(x) && purrr::some(x, has_sexpr))
}

# \Sexpr (directly, through a user macro, or through system macros such as
# \doi) is evaluated by R when the Rd is installed or rendered.
rd_is_safe <- function(rd_text) {
  parsed <- tryCatch(
    suppressWarnings(tools::parse_Rd(
      textConnection(rd_text),
      warningCalls = FALSE
    )),
    error = \(e) NULL
  )
  !is.null(parsed) && !has_sexpr(parsed)
}

missing_inherit_packages <- function(records) {
  records |>
    purrr::map(\(r) r$external) |>
    purrr::list_c() |>
    purrr::keep(\(src) {
      pkg <- sub("::.*$", "", src)
      !nzchar(system.file(package = pkg))
    }) |>
    unique()
}

build_file <- function(text) {
  prepared <- text |> split_lines() |> strip_r_code() |> with_markdown_tags()
  joined <- paste(prepared, collapse = "\n")
  env <- joined |> parse(text = _, keep.source = FALSE) |> sandbox_functions()
  install_eval_guards()
  notes <- character()
  blocks <- withCallingHandlers(
    roxygen2::parse_text(joined, env = env),
    warning = \(w) invokeRestart("muffleWarning")
  )
  rd_topics <- withCallingHandlers(
    roxygen2::roclet_process(
      roxygen2::rd_roclet(),
      blocks,
      env,
      base_path = empty_base_path()
    ),
    warning = \(w) invokeRestart("muffleWarning")
  )
  records <- rd_topics |> unname() |> purrr::map(\(rd) topic_record(rd, blocks))
  rd_text <- rd_topics |>
    purrr::map_chr(\(rd) paste(format(rd), collapse = "\n"))
  safe <- purrr::map_lgl(rd_text, rd_is_safe)
  if (!all(safe)) {
    unsafe <- purrr::map_chr(records[!safe], \(r) r$name)
    notes <- c(
      notes,
      paste0(
        "Rd for ",
        paste(unsafe, collapse = ", "),
        " contains \\Sexpr or fails to parse; omitted from the help package"
      )
    )
  }
  absent <- missing_inherit_packages(records)
  notes <- c(
    notes,
    absent |>
      purrr::map_chr(\(src) {
        paste0(
          "cannot resolve inheritance from '",
          src,
          "': package not installed"
        )
      })
  )
  list(
    records = records,
    rd = rd_text[safe] |> purrr::set_names(names(rd_topics)[safe]),
    notes = notes
  )
}

# Manifest assembly -------------------------------------------------------------------

find_local_topic <- function(source, from_path, files) {
  candidates <- files |>
    purrr::imap(\(f, path) {
      purrr::keep(f$records, \(r) source %in% r$aliases) |>
        purrr::map(\(r) list(path = path, record = r))
    }) |>
    purrr::list_c()
  if (length(candidates) == 0L) {
    return(NULL)
  }
  same_file <- purrr::keep(candidates, \(c) c$path == from_path)
  if (length(same_file) > 0L) {
    return(same_file[[1L]])
  }
  candidates[[order(purrr::map_chr(candidates, \(c) c$path))[[1L]]]]
}

local_param_md <- function(record, name, path, files, seen = character()) {
  own <- purrr::keep(record$params, \(p) p$name == name && p$from == "local")
  if (length(own) > 0L) {
    return(own[[1L]]$md)
  }
  key <- paste(path, record$name)
  if (key %in% seen) {
    return(NULL)
  }
  record$sources |>
    purrr::map(\(src) {
      hit <- find_local_topic(src, path, files)
      if (is.null(hit)) NULL else
        local_param_md(hit$record, name, hit$path, files, c(seen, key))
    }) |>
    purrr::compact() |>
    purrr::pluck(1L)
}

# roxygen2 only sees one file at a time, so parameters inherited from topics
# in other workspace files are resolved here on the markdown source instead.
resolve_params <- function(record, path, files) {
  wanted <- unique(c(
    record$formals,
    purrr::map_chr(record$params, \(p) p$name)
  ))
  resolved <- wanted |>
    purrr::map(\(name) {
      own <- purrr::keep(record$params, \(p) p$name == name)
      if (length(own) > 0L && own[[1L]]$from == "local") {
        return(own[[1L]])
      }
      md <- record$sources |>
        purrr::map(\(src) {
          hit <- find_local_topic(src, path, files)
          if (is.null(hit)) NULL else
            local_param_md(
              hit$record,
              name,
              hit$path,
              files,
              paste(path, record$name)
            )
        }) |>
        purrr::compact() |>
        purrr::pluck(1L)
      if (!is.null(md)) {
        list(name = name, md = md, from = "local")
      } else if (length(own) > 0L) {
        own[[1L]]
      }
    }) |>
    purrr::compact()
  documented <- purrr::map_chr(resolved, \(p) p$name)
  ordered <- c(
    resolved[match(intersect(record$formals, documented), documented)],
    resolved[!documented %in% record$formals]
  )
  ordered
}

manifest_topic <- function(record, path, files) {
  params <- resolve_params(record, path, files)
  used_rd <- record$fields_from_rd ||
    any(purrr::map_lgl(params, \(p) p$from == "rd"))
  list(
    name = record$name,
    aliases = I(as.character(record$aliases)),
    title = record$title,
    description_md = record$description_md,
    details_md = record$details_md,
    params = purrr::map(params, \(p) list(name = p$name, md = p$md)),
    returns_md = record$returns_md,
    sections = purrr::map(
      record$sections,
      \(s) list(title = s$title, md = s$md)
    ),
    examples = record$examples,
    inherited_from = I(as.character(if (used_rd) record$external))
  )
}

# The lexicographically smallest path wins a name, matching the Rust core.
winning_rd <- function(files) {
  paths <- sort(names(files))
  claimed <- character()
  claimed_files <- character()
  out <- list()
  for (path in paths) {
    entry <- files[[path]]
    names_in_file <- names(entry$rd)
    for (i in seq_along(entry$rd)) {
      rd_name <- entry$records[[i]]$name
      topic_file <- names_in_file[[i]]
      if (rd_name %in% claimed || topic_file %in% claimed_files) {
        next
      }
      claimed <- c(claimed, rd_name)
      claimed_files <- c(claimed_files, topic_file)
      out[[topic_file]] <- list(
        text = entry$rd[[i]],
        aliases = entry$records[[i]]$aliases
      )
    }
  }
  out
}

# Install -----------------------------------------------------------------------------

new_state <- function() {
  state <- new.env(parent = emptyenv())
  state$cache <- list()
  state$generation <- 0L
  state$install_signature <- NULL
  state$lib_dir <- NULL
  state$shutdown <- FALSE
  state
}

existing_generations <- function(lib_root) {
  dirs <- list.files(lib_root, pattern = "^lib-[0-9]+$")
  as.integer(sub("^lib-", "", dirs))
}

write_docs_package <- function(src, rd_files) {
  dir.create(file.path(src, "man"), recursive = TRUE)
  writeLines(
    c(
      "Package: rozone.docs",
      "Version: 0.0.1",
      "Title: Documentation for Script Functions",
      "Description: Generated by rozone.",
      "License: MIT",
      "Encoding: UTF-8"
    ),
    file.path(src, "DESCRIPTION")
  )
  writeLines("", file.path(src, "NAMESPACE"))
  rd_files |>
    purrr::iwalk(\(rd, file) {
      writeLines(
        enc2utf8(rd$text),
        file.path(src, "man", file),
        useBytes = TRUE
      )
    })
}

# The child R inherits our working directory and environment; neutralise
# user/project profiles so a workspace .Rprofile never runs during install.
run_r_cmd_install <- function(src, lib, log) {
  empty <- tempfile("empty-profile")
  file.create(empty)
  old <- setwd(tempdir())
  on.exit(setwd(old), add = TRUE)
  suppressWarnings(system2(
    file.path(R.home("bin"), "R"),
    c(
      "CMD",
      "INSTALL",
      "--no-test-load",
      "--no-byte-compile",
      "--no-multiarch",
      "-l",
      shQuote(lib),
      shQuote(src)
    ),
    stdout = log,
    stderr = log,
    env = c(paste0("R_PROFILE_USER=", empty), paste0("R_ENVIRON_USER=", empty))
  ))
}

install_docs <- function(rd_files, lib_root, state) {
  dir.create(lib_root, recursive = TRUE, showWarnings = FALSE)
  state$generation <- max(c(state$generation, existing_generations(lib_root))) +
    1L
  lib <- file.path(lib_root, paste0("lib-", state$generation))
  dir.create(lib)
  tmp <- tempfile("rozone-src")
  on.exit(unlink(tmp, recursive = TRUE), add = TRUE)
  src <- file.path(tmp, "rozone.docs")
  write_docs_package(src, rd_files)
  log <- tempfile(fileext = ".log")
  status <- run_r_cmd_install(src, lib, log)
  cat(readLines(log, warn = FALSE), sep = "\n", file = stderr())
  if (!identical(status, 0L)) {
    unlink(lib, recursive = TRUE)
    stop("R CMD INSTALL failed with status ", status, call. = FALSE)
  }
  old <- setdiff(existing_generations(lib_root), state$generation)
  old[old < state$generation] |>
    purrr::walk(
      \(g)
        unlink(
          file.path(lib_root, paste0("lib-", g)),
          recursive = TRUE,
          force = TRUE
        )
    )
  lib
}

# Requests -----------------------------------------------------------------------------

file_text <- function(file) {
  if (!is.null(file$text)) {
    return(file$text)
  }
  file$path |>
    readLines(warn = FALSE, encoding = "UTF-8") |>
    paste(collapse = "\n")
}

entry_for <- function(file, state) {
  path <- file$path
  hash <- file$hash
  if (!is.character(path) || length(path) != 1L) {
    stop("each file needs a string `path`", call. = FALSE)
  }
  cached <- state$cache[[path]]
  if (!is.null(cached) && identical(cached$hash, hash)) {
    return(list(entry = cached, hit = TRUE))
  }
  entry <- tryCatch(
    c(build_file(file_text(file)), list(hash = hash, error = NULL)),
    error = \(e)
      list(
        hash = hash,
        error = conditionMessage(e),
        records = list(),
        rd = list(),
        notes = character()
      )
  )
  state$cache[[path]] <- entry
  list(entry = entry, hit = FALSE)
}

handle_build <- function(params, state) {
  files <- params$files %||% list()
  paths <- purrr::map_chr(files, \(f) f$path %||% NA_character_)
  if (anyNA(paths)) {
    stop("each file needs a string `path`", call. = FALSE)
  }
  install <- isTRUE(params$install)
  if (install && !is.character(params$lib_root)) {
    stop("`install` requires `lib_root`", call. = FALSE)
  }
  state$cache <- state$cache[names(state$cache) %in% paths]

  built <- files |>
    purrr::map(\(f) entry_for(f, state)) |>
    purrr::set_names(paths)
  entries <- purrr::map(built, "entry")
  hits <- sum(purrr::map_lgl(built, "hit"))
  ok <- purrr::keep(entries, \(e) is.null(e$error))

  errors <- entries |>
    purrr::imap(\(e, path) {
      messages <- c(e$error, e$notes)
      purrr::map(messages, \(m) list(path = path, message = m))
    }) |>
    purrr::list_c() %||%
    list()

  manifest_files <- paths |>
    purrr::keep(\(p) p %in% names(ok)) |>
    purrr::map(\(path) {
      list(
        path = path,
        content_hash = ok[[path]]$hash,
        topics = purrr::map(
          ok[[path]]$records,
          \(r) manifest_topic(r, path, ok)
        )
      )
    })

  winners <- winning_rd(ok)
  topics <- winners |>
    purrr::map(\(w) w$aliases) |>
    purrr::list_c() |>
    unique() |>
    sort()

  lib_dir <- NULL
  if (install) {
    signature <- ok[sort(names(ok))] |>
      purrr::imap_chr(\(e, p) paste(p, e$hash)) |>
      paste(collapse = "\n") |>
      paste(params$lib_root, sep = "\n")
    reusable <- identical(state$install_signature, signature) &&
      !is.null(state$lib_dir) &&
      dir.exists(state$lib_dir)
    if (reusable) {
      lib_dir <- state$lib_dir
    } else {
      installed <- tryCatch(
        install_docs(winners, params$lib_root, state),
        error = \(e) {
          errors <<- c(
            errors,
            list(list(path = "rozone.docs", message = conditionMessage(e)))
          )
          NULL
        }
      )
      if (!is.null(installed)) {
        lib_dir <- installed
        state$lib_dir <- installed
        state$install_signature <- signature
      }
    }
  }

  list(
    manifest = list(version = 1L, files = manifest_files),
    lib_dir = lib_dir,
    topics = I(as.character(topics)),
    cache_hits = hits,
    errors = errors
  )
}

handle_request <- function(req, state) {
  switch(
    req$method,
    ping = list(pong = TRUE),
    shutdown = {
      state$shutdown <- TRUE
      list(ok = TRUE)
    },
    build = handle_build(req$params %||% list(), state),
    stop("unknown method: ", req$method, call. = FALSE)
  )
}

error_response <- function(id, message) {
  list(id = id, error = list(message = message))
}

with_stdout_diverted <- function(code) {
  sink(stderr(), type = "output")
  on.exit(sink(type = "output"), add = TRUE)
  code
}

# Returns the response object for one input line, or NULL for a blank line.
process_line <- function(line, state) {
  if (!nzchar(trimws(line))) {
    return(NULL)
  }
  req <- tryCatch(
    jsonlite::fromJSON(line, simplifyVector = FALSE),
    error = \(e) NULL
  )
  if (!is.list(req) || is.null(names(req))) {
    return(error_response(NULL, "malformed request: expected a JSON object"))
  }
  id <- req$id
  if (!is.character(req$method) || length(req$method) != 1L) {
    return(error_response(id, "request is missing a string `method`"))
  }
  tryCatch(
    list(id = id, result = with_stdout_diverted(handle_request(req, state))),
    error = \(e) error_response(id, conditionMessage(e))
  )
}

main <- function() {
  options(warn = 1L)
  required <- required_packages()
  hello <- hello_line(required)
  write_protocol_line(hello$line)
  if (!hello$ok) {
    quit(save = "no", status = 3L)
  }

  state <- new_state()
  con <- file("stdin", open = "r")
  on.exit(close(con), add = TRUE)
  repeat {
    line <- readLines(con, n = 1L, warn = FALSE, encoding = "UTF-8")
    if (length(line) == 0L) {
      break
    }
    response <- process_line(line, state)
    if (!is.null(response)) {
      emit(response)
    }
    if (state$shutdown) {
      break
    }
  }
  invisible(NULL)
}

if (sys.nframe() == 0L) {
  main()
}
