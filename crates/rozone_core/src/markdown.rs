//! Markdown output: roxygen link conversion, hover text, signature help text
//! and the full documentation page.

use crate::extract::Formal;
use crate::resolve::Resolved;

pub struct Signature {
    pub label: String,
    /// UTF-16 `[start, end)` of each formal inside `label`.
    pub params: Vec<[u32; 2]>,
}

pub fn signature(name: &str, formals: &[Formal]) -> Signature {
    let mut label = format!("{name}(");
    let mut width = utf16_len(&label);
    let mut params = Vec::with_capacity(formals.len());
    for (i, formal) in formals.iter().enumerate() {
        if i > 0 {
            label.push_str(", ");
            width += 2;
        }
        let text = match &formal.default {
            Some(default) => format!("{} = {}", formal.name, collapse_lines(default)),
            None => formal.name.clone(),
        };
        let len = utf16_len(&text);
        params.push([width, width + len]);
        width += len;
        label.push_str(&text);
    }
    label.push(')');
    Signature { label, params }
}

fn utf16_len(text: &str) -> u32 {
    text.encode_utf16().count() as u32
}

/// Default values may span lines; the label must stay on one.
fn collapse_lines(text: &str) -> String {
    if !text.contains('\n') {
        return text.to_string();
    }
    text.lines().map(str::trim).collect::<Vec<_>>().join(" ")
}

/// Convert roxygen's link shorthand to plain markdown, leaving code spans,
/// fences and ordinary `[text](url)` links alone.
pub fn convert_links(text: &str) -> String {
    if !text.contains('[') {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut in_fence = false;
    for (i, line) in text.split('\n').enumerate() {
        if i > 0 {
            out.push('\n');
        }
        if line.trim_start().starts_with("```") {
            in_fence = !in_fence;
            out.push_str(line);
        } else if in_fence {
            out.push_str(line);
        } else {
            convert_line(line, &mut out);
        }
    }
    out
}

fn convert_line(line: &str, out: &mut String) {
    let mut rest = line;
    while let Some(i) = rest.find(['`', '[']) {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        let consumed = if rest.starts_with('`') {
            copy_code_span(rest, out)
        } else if out
            .chars()
            .next_back()
            .is_some_and(|c| c.is_alphanumeric() || matches!(c, ')' | ']' | '[' | '_' | '.'))
        {
            out.push('[');
            1
        } else {
            convert_link(rest, out)
        };
        rest = &rest[consumed..];
    }
    out.push_str(rest);
}

/// Copies a code span (or just the lone backtick run) and returns its length.
fn copy_code_span(s: &str, out: &mut String) -> usize {
    let run = s.len() - s.trim_start_matches('`').len();
    let ticks = &s[..run];
    let end = s[run..].find(ticks).map_or(run, |at| run + at + run);
    out.push_str(&s[..end]);
    end
}

/// `s` starts with `[`. Returns the number of bytes consumed.
fn convert_link(s: &str, out: &mut String) -> usize {
    let Some(close) = closing_bracket(s) else {
        out.push('[');
        return 1;
    };
    let inner = &s[1..close];
    let after = &s[close + 1..];
    if after.starts_with('(') || after.starts_with(':') {
        out.push_str(&s[..=close]);
        return close + 1;
    }
    if let Some(dest_and_rest) = after.strip_prefix('[')
        && let Some(end) = dest_and_rest.find(']')
        && is_destination(&dest_and_rest[..end])
        && !inner.is_empty()
    {
        out.push_str(inner);
        return close + 1 + 1 + end + 1;
    }
    if is_code_text(inner) || is_topic_reference(inner) {
        if inner.starts_with('`') {
            out.push_str(inner);
        } else {
            out.push('`');
            out.push_str(inner);
            out.push('`');
        }
        return close + 1;
    }
    out.push('[');
    1
}

/// Index of the `]` matching the opening `[`, ignoring brackets in code spans.
fn closing_bracket(s: &str) -> Option<usize> {
    let mut in_code = false;
    for (i, c) in s.char_indices().skip(1) {
        match c {
            '`' => in_code = !in_code,
            '[' if !in_code => return None,
            ']' if !in_code => return Some(i),
            _ => {}
        }
    }
    None
}

fn is_destination(dest: &str) -> bool {
    !dest.is_empty() && !dest.contains(char::is_whitespace)
}

fn is_code_text(inner: &str) -> bool {
    inner.len() > 2
        && inner.starts_with('`')
        && inner.ends_with('`')
        && !inner[1..inner.len() - 1].contains('`')
}

/// `fn`, `fn()`, `pkg::fn`, `pkg::fn()`.
fn is_topic_reference(inner: &str) -> bool {
    let inner = inner.strip_suffix("()").unwrap_or(inner);
    let is_ident = |part: &str| {
        let mut chars = part.chars();
        chars.next().is_some_and(|c| c.is_alphabetic() || c == '.')
            && chars.all(|c| c.is_alphanumeric() || c == '.' || c == '_')
    };
    match inner.split_once("::") {
        Some((pkg, name)) => is_ident(pkg) && is_ident(name),
        None => is_ident(inner),
    }
}

/// One table row per argument. Like Rd, adjacent arguments that share a
/// description (`@param x,y`) share a row.
fn argument_table(params: &[(String, String)]) -> String {
    let mut rows: Vec<(Vec<&str>, &str)> = Vec::new();
    for (name, text) in params {
        match rows.last_mut() {
            Some((names, shared)) if *shared == text.as_str() => names.push(name),
            _ => rows.push((vec![name], text)),
        }
    }
    let mut table = String::from("|     |     |\n| --- | --- |");
    for (names, text) in rows {
        let names = names
            .iter()
            .map(|n| format!("`{n}`"))
            .collect::<Vec<_>>()
            .join(", ");
        table.push_str(&format!(
            "\n| {} | {} |",
            table_cell(&names),
            table_cell(&convert_links(text))
        ));
    }
    table
}

/// Table cells are a single line, and `|` would end the cell.
fn table_cell(text: &str) -> String {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
        .replace('|', "\\|")
}

fn code_block(code: &str) -> String {
    format!("```r\n{code}\n```")
}

fn push_section(out: &mut Vec<String>, heading: &str, body: Option<&str>) {
    if let Some(body) = body.filter(|b| !b.trim().is_empty()) {
        out.push(format!("### {heading}\n\n{}", convert_links(body)));
    }
}

/// Title and description: the signature-help documentation.
pub fn summary(doc: &Resolved) -> String {
    let mut parts = Vec::new();
    if let Some(title) = &doc.title {
        parts.push(format!("**{}**", convert_links(title)));
    }
    parts.extend(doc.related.iter().cloned());
    if let Some(description) = &doc.description {
        parts.push(convert_links(description));
    }
    parts.join("\n\n")
}

pub fn param_doc(doc: &Resolved, name: &str) -> String {
    doc.params
        .iter()
        .find(|(n, _)| n == name)
        .map(|(_, text)| convert_links(text))
        .unwrap_or_default()
}

/// The help page shown on hover and in the documentation preview, laid out
/// like Ark's rendering of an R help page so script and package docs match.
pub fn help_page(name: &str, file_label: &str, signature: &str, doc: &Resolved) -> String {
    let mut parts = vec![format!("_{name} {{{file_label}}}_")];
    if let Some(title) = &doc.title {
        parts.push(format!("## {}", convert_links(title)));
    }
    parts.push("------".to_string());
    parts.extend(doc.related.iter().cloned());
    push_section(&mut parts, "Description", doc.description.as_deref());
    parts.push(format!("### Usage\n\n{}", code_block(signature)));
    if !doc.params.is_empty() {
        parts.push(format!("### Arguments\n\n{}", argument_table(&doc.params)));
    }
    push_section(&mut parts, "Details", doc.details.as_deref());
    push_section(&mut parts, "Value", doc.returns.as_deref());
    for (title, text) in &doc.sections {
        push_section(&mut parts, title, Some(text));
    }
    let mut see_also = String::new();
    if let Some(text) = &doc.seealso {
        see_also.push_str(&convert_links(text));
    }
    if let Some(family) = &doc.family {
        if !see_also.is_empty() {
            see_also.push_str("\n\n");
        }
        see_also.push_str(&format!("Family: {family}"));
    }
    push_section(&mut parts, "See Also", Some(&see_also));
    if doc.examples.is_some() || !doc.example_files.is_empty() {
        let mut body = Vec::new();
        body.extend(doc.examples.as_deref().map(code_block));
        body.extend(
            doc.example_files
                .iter()
                .map(|file| format!("See `{file}`.")),
        );
        parts.push(format!("### Examples\n\n{}", body.join("\n\n")));
    }
    parts.extend(doc.notes.iter().map(|note| format!("_{note}_")));
    parts.join("\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn link_conversion_table() {
        let cases = [
            ("see [fn()]", "see `fn()`"),
            ("see [pkg::fn()]", "see `pkg::fn()`"),
            ("see [text][pkg::fn]", "see text"),
            ("see [pkg::fn]", "see `pkg::fn`"),
            ("see [`text`][dest]", "see `text`"),
            ("see [`fn()`]", "see `fn()`"),
            (
                "<[`data-masked`][dplyr::dplyr_data_masking]> col",
                "<`data-masked`> col",
            ),
            ("a [link](http://x.y) b", "a [link](http://x.y) b"),
            ("keep `[fn()]` code", "keep `[fn()]` code"),
            ("keep ``a ` [fn()]`` code", "keep ``a ` [fn()]`` code"),
            ("x[1] and [1] and [a b]", "x[1] and [1] and [a b]"),
            ("unterminated [fn", "unterminated [fn"),
            ("nested [a [b]]", "nested [a `b`]"),
            ("[stats::sd()] and [mean()]", "`stats::sd()` and `mean()`"),
            ("ref [x]: def", "ref [x]: def"),
        ];
        for (input, expected) in cases {
            assert_eq!(convert_links(input), expected, "{input}");
        }
    }

    #[test]
    fn subsetting_brackets_in_prose() {
        assert_eq!(convert_links("x[i] is x[[i]]"), "x[i] is x[[i]]");
    }

    #[test]
    fn fences_are_left_alone() {
        let text = "before [fn()]\n```r\nx[fn()]\n```\nafter [fn()]";
        assert_eq!(
            convert_links(text),
            "before `fn()`\n```r\nx[fn()]\n```\nafter `fn()`"
        );
    }

    #[test]
    fn signature_offsets_are_utf16() {
        let formals = vec![
            Formal {
                name: "x".into(),
                default: None,
            },
            Formal {
                name: "é".into(),
                default: Some("\"😀\"".into()),
            },
            Formal {
                name: "...".into(),
                default: None,
            },
        ];
        let sig = signature("f", &formals);
        assert_eq!(sig.label, "f(x, é = \"😀\", ...)");
        let units: Vec<u16> = sig.label.encode_utf16().collect();
        let slice = |[s, e]: [u32; 2]| String::from_utf16(&units[s as usize..e as usize]).unwrap();
        assert_eq!(slice(sig.params[0]), "x");
        assert_eq!(slice(sig.params[1]), "é = \"😀\"");
        assert_eq!(slice(sig.params[2]), "...");
    }

    #[test]
    fn multiline_defaults_are_collapsed() {
        let formals = vec![Formal {
            name: "x".into(),
            default: Some("c(1,\n      2)".into()),
        }];
        assert_eq!(signature("f", &formals).label, "f(x = c(1, 2))");
    }

    #[test]
    fn no_formals() {
        let sig = signature("f", &[]);
        assert_eq!(sig.label, "f()");
        assert!(sig.params.is_empty());
    }

    #[test]
    fn argument_rows_are_single_line_and_shared_descriptions_merge() {
        let params = vec![
            ("x".to_string(), "Shared.".to_string()),
            ("y".to_string(), "Shared.".to_string()),
            (
                "z".to_string(),
                "Uses [fn()],\n  then `a | b`.\n\nMore.".to_string(),
            ),
        ];
        assert_eq!(
            argument_table(&params),
            "|     |     |\n| --- | --- |\n| `x`, `y` | Shared. |\n| `z` | Uses `fn()`, then `a \\| b`. More. |"
        );
    }
}
