//! Removes R code from roxygen comment lines. A port of `strip_r_code()` in
//! `spike/ark_help_injection.R`: documenting a script must never evaluate code.

/// The text of a roxygen line after the `#'` prefix and one optional
/// whitespace character, or `None` for any other line. Like roxygen2 (and
/// unlike the R spike) this also accepts `##'`; those lines are stripped too.
pub fn roxygen_body(line: &str) -> Option<&str> {
    let rest = line.trim_start().strip_prefix('#')?.trim_start_matches('#').strip_prefix('\'')?;
    let mut chars = rest.chars();
    Some(match chars.next() {
        Some(c) if c.is_whitespace() => chars.as_str(),
        _ => rest,
    })
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum State {
    Keep,
    Fence,
    FenceEnd,
    Eval,
}

/// Strip inline `` `r ...` ``, ```` ```{r} ```` fences and `@eval*` /
/// `@includeRmd` tags (with their continuation lines) from `lines`.
pub fn strip_r_code<S: AsRef<str>>(lines: &[S]) -> Vec<String> {
    let mut kept = Vec::with_capacity(lines.len());
    let mut state = State::Keep;
    for line in lines {
        let line = line.as_ref();
        if roxygen_body(line).is_none() {
            kept.push(line.to_string());
            state = State::Keep;
            continue;
        }
        let line = remove_inline_r(line);
        let body = roxygen_body(&line).unwrap_or_default();
        let starts_tag = body.starts_with('@');
        let is_fence = body.starts_with("```");
        state = if state == State::Fence {
            if is_fence { State::FenceEnd } else { State::Fence }
        } else if opens_r_fence(body) {
            State::Fence
        } else if starts_eval(body) || (state == State::Eval && !starts_tag) {
            State::Eval
        } else {
            State::Keep
        };
        if state == State::Keep {
            kept.push(line);
        }
    }
    kept
}

/// `gsub("`r [^`]*`", "", line)`
fn remove_inline_r(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(start) = rest.find("`r ") {
        let after = &rest[start + 3..];
        let Some(close) = after.find('`') else { break };
        out.push_str(&rest[..start]);
        rest = &after[close + 1..];
    }
    out.push_str(rest);
    out
}

/// `^```+\s*\{r`
fn opens_r_fence(body: &str) -> bool {
    let rest = body.trim_start_matches('`');
    body.len() - rest.len() >= 3 && rest.trim_start().starts_with("{r")
}

/// `^@(eval(Rd|Namespace)?|includeRmd)\b`
fn starts_eval(body: &str) -> bool {
    let Some(tag) = body.strip_prefix('@') else { return false };
    ["evalRd", "evalNamespace", "eval", "includeRmd"].iter().any(|name| {
        tag.strip_prefix(name)
            .is_some_and(|after| !after.starts_with(|c: char| c.is_alphanumeric() || c == '_'))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strip(lines: &[&str]) -> Vec<String> {
        strip_r_code(lines)
    }

    #[test]
    fn inline_r_is_removed_in_place() {
        assert_eq!(strip(&["#' Today is `r Sys.Date()` ok"]), ["#' Today is  ok"]);
        assert_eq!(strip(&["#' `r 1` and `r 2`"]), ["#'  and "]);
        assert_eq!(strip(&["#' keep `r` and `rx 1` and `code`"]), ["#' keep `r` and `rx 1` and `code`"]);
    }

    #[test]
    fn unterminated_inline_r_is_kept() {
        assert_eq!(strip(&["#' a `r b"]), ["#' a `r b"]);
    }

    #[test]
    fn inline_r_only_on_roxygen_lines() {
        assert_eq!(strip(&["x <- `r 1`"]), ["x <- `r 1`"]);
    }

    #[test]
    fn r_fences_removed_through_closing_fence() {
        let lines = ["#' before", "#' ```{r}", "#' system('x')", "#' ```", "#' after"];
        assert_eq!(strip(&lines), ["#' before", "#' after"]);
        let lines = ["#' ```{r, echo = FALSE}", "#' x", "#' ```", "#' after"];
        assert_eq!(strip(&lines), ["#' after"]);
        let lines = ["#' ````{r}", "#' x", "#' ````", "#' after"];
        assert_eq!(strip(&lines), ["#' after"]);
    }

    #[test]
    fn non_r_fences_are_kept() {
        let lines = ["#' ```r", "#' x <- 1", "#' ```"];
        assert_eq!(strip(&lines), lines);
    }

    #[test]
    fn unterminated_fence_drops_rest_of_block() {
        assert_eq!(strip(&["#' a", "#' ```{r}", "#' b", "#' @param x y"]), ["#' a"]);
    }

    #[test]
    fn eval_tags_drop_continuations_until_next_tag() {
        let lines = ["#' Title", "#' @eval foo()", "#'   more()", "#' @param x A thing", "#' @evalRd bar()", "#' @export"];
        assert_eq!(strip(&lines), ["#' Title", "#' @param x A thing", "#' @export"]);
    }

    #[test]
    fn eval_namespace_and_include_rmd() {
        let lines = ["#' @evalNamespace x", "#' cont", "#' @includeRmd f.Rmd", "#' cont", "#' @return y"];
        assert_eq!(strip(&lines), ["#' @return y"]);
    }

    #[test]
    fn similar_tag_names_are_not_eval() {
        let lines = ["#' @evaluate x", "#' @eval_it x", "#' @evalfoo"];
        assert_eq!(strip(&lines), lines);
    }

    #[test]
    fn eval_boundary_with_punctuation() {
        assert!(strip(&["#' @eval(foo)"]).is_empty());
        assert!(strip(&["#' @eval"]).is_empty());
    }

    #[test]
    fn non_roxygen_lines_reset_state() {
        let lines = ["#' @eval x", "# plain", "#' kept"];
        assert_eq!(strip(&lines), ["# plain", "#' kept"]);
    }

    #[test]
    fn eval_inside_fence_is_dropped_with_the_fence() {
        let lines = ["#' ```{r}", "#' @eval x", "#' ```", "#' after"];
        assert_eq!(strip(&lines), ["#' after"]);
    }

    #[test]
    fn inline_r_inside_eval_continuation_is_irrelevant() {
        let lines = ["#' @eval f(`r 1`)", "#' next"];
        assert!(strip(&lines).is_empty());
    }

    #[test]
    fn body_prefix_rules() {
        assert_eq!(roxygen_body("#' hello"), Some("hello"));
        assert_eq!(roxygen_body("#'hello"), Some("hello"));
        assert_eq!(roxygen_body("#'  two"), Some(" two"));
        assert_eq!(roxygen_body("  #' indented"), Some("indented"));
        assert_eq!(roxygen_body("#'"), Some(""));
        assert_eq!(roxygen_body("##' double"), Some("double"));
        assert_eq!(roxygen_body("# plain"), None);
        assert_eq!(roxygen_body("x <- 1"), None);
    }
}
