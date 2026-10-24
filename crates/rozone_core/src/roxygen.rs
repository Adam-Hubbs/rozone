//! The roxygen subset: a `#'` block parsed into a [`Block`].

use crate::strip::{roxygen_body, strip_r_code};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParamDoc {
    pub names: Vec<String>,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Section {
    pub title: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Inherit {
    pub source: String,
    /// Empty means every field.
    pub fields: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DescribeIn {
    pub parent: String,
    pub description: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Block {
    pub title: Option<String>,
    pub description: Option<String>,
    pub details: Option<String>,
    pub params: Vec<ParamDoc>,
    pub returns: Option<String>,
    pub examples: Option<String>,
    pub example_files: Vec<String>,
    pub sections: Vec<Section>,
    pub seealso: Option<String>,
    pub family: Option<String>,
    pub inherit_params: Vec<String>,
    pub inherit: Vec<Inherit>,
    pub inherit_dots: Vec<String>,
    pub inherit_sections: Vec<String>,
    pub describe_in: Option<DescribeIn>,
    pub rdname: Option<String>,
    pub templates: Vec<String>,
    pub keywords: Vec<String>,
    pub no_rd: bool,
    pub export: bool,
    pub md: Option<bool>,
}

impl Block {
    /// Whether the block says anything beyond bookkeeping tags such as `@export`.
    pub fn has_content(&self) -> bool {
        self.title.is_some()
            || self.description.is_some()
            || self.details.is_some()
            || !self.params.is_empty()
            || self.returns.is_some()
            || self.examples.is_some()
            || !self.example_files.is_empty()
            || !self.sections.is_empty()
            || self.seealso.is_some()
            || !self.inherit_params.is_empty()
            || !self.inherit.is_empty()
            || !self.inherit_dots.is_empty()
            || !self.inherit_sections.is_empty()
            || self.describe_in.is_some()
            || self.rdname.is_some()
    }

    pub fn param(&self, name: &str) -> Option<&str> {
        self.params
            .iter()
            .find(|param| param.names.iter().any(|n| n == name))
            .map(|param| param.text.as_str())
    }
}

/// Parse the raw comment lines (`#' ...`) of one block. R code in the lines is
/// stripped first.
pub fn parse_block<S: AsRef<str>>(raw_lines: &[S]) -> Block {
    let bodies: Vec<String> = strip_r_code(raw_lines)
        .iter()
        .map(|line| roxygen_body(line).unwrap_or_default().to_string())
        .collect();
    let (intro, tags) = split_tags(&bodies);
    let mut block = Block::default();
    apply_intro(&mut block, &intro);
    for (tag, content) in tags {
        apply_tag(&mut block, &tag, &content);
    }
    block
}

type RawTag = (String, String);

fn split_tags(bodies: &[String]) -> (Vec<&str>, Vec<RawTag>) {
    let mut intro = Vec::new();
    let mut tags: Vec<(String, Vec<&str>)> = Vec::new();
    for line in bodies {
        match tag_start(line) {
            Some((name, rest)) => tags.push((name.to_string(), vec![rest])),
            None => match tags.last_mut() {
                Some((_, lines)) => lines.push(line),
                None => intro.push(line.as_str()),
            },
        }
    }
    let tags = tags
        .into_iter()
        .map(|(name, lines)| (name, unescape(&join_content(&lines))))
        .collect();
    (intro, tags)
}

/// `@name rest`; `@@` is an escaped at-sign, not a tag.
fn tag_start(line: &str) -> Option<(&str, &str)> {
    let rest = line.strip_prefix('@')?;
    let end = rest.find(|c: char| !c.is_alphanumeric()).unwrap_or(rest.len());
    if end == 0 {
        return None;
    }
    let (name, rest) = rest.split_at(end);
    if !(rest.is_empty() || rest.starts_with(char::is_whitespace)) {
        return None;
    }
    Some((name, rest.trim_start()))
}

/// The first line was already left-trimmed; later lines keep their indentation.
fn join_content(lines: &[&str]) -> String {
    let joined = lines.join("\n");
    joined.trim_start_matches(['\n', ' ', '\t']).trim_end().to_string()
}

fn unescape(text: &str) -> String {
    if text.contains("@@") { text.replace("@@", "@") } else { text.to_string() }
}

fn apply_intro(block: &mut Block, intro: &[&str]) {
    let paragraphs = paragraphs(intro);
    let mut paragraphs = paragraphs.into_iter();
    let text = |paragraph: Vec<&str>, sep: &str| unescape(paragraph.join(sep).trim());
    block.title = paragraphs.next().map(|p| text(p, " ")).filter(|t| !t.is_empty());
    block.description = paragraphs.next().map(|p| text(p, "\n")).filter(|t| !t.is_empty());
    let details = paragraphs.map(|p| text(p, "\n")).collect::<Vec<_>>().join("\n\n");
    block.details = Some(details).filter(|t| !t.is_empty());
}

/// Blank-line separated paragraphs; blank lines inside code fences do not split.
fn paragraphs<'a>(lines: &[&'a str]) -> Vec<Vec<&'a str>> {
    let mut paragraphs = Vec::new();
    let mut current: Vec<&str> = Vec::new();
    let mut in_fence = false;
    for line in lines {
        if line.trim_start().starts_with("```") {
            in_fence = !in_fence;
        }
        if line.trim().is_empty() && !in_fence {
            if !current.is_empty() {
                paragraphs.push(std::mem::take(&mut current));
            }
        } else {
            current.push(line);
        }
    }
    if !current.is_empty() {
        paragraphs.push(current);
    }
    paragraphs
}

fn apply_tag(block: &mut Block, tag: &str, content: &str) {
    let non_empty = || Some(content.to_string()).filter(|c| !c.is_empty());
    let words = || content.split_whitespace().map(str::to_string);
    match tag {
        "title" => block.title = non_empty().map(|t| t.split_whitespace().collect::<Vec<_>>().join(" ")),
        "description" => block.description = non_empty(),
        "details" => block.details = non_empty(),
        "param" => {
            let (names, text) = split_first_word(content);
            let names: Vec<String> = names
                .split(',')
                .map(|name| name.trim().trim_matches('`').to_string())
                .filter(|name| !name.is_empty())
                .collect();
            if !names.is_empty() && !text.is_empty() {
                block.params.push(ParamDoc { names, text: text.to_string() });
            }
        }
        "return" | "returns" => {
            if block.returns.is_none() {
                block.returns = non_empty();
            }
        }
        "examples" => block.examples = non_empty(),
        "example" => block.example_files.extend(content.lines().map(str::trim).filter(|l| !l.is_empty()).map(str::to_string)),
        "section" => {
            if let Some((title, text)) = content.split_once(':') {
                block.sections.push(Section { title: title.trim().to_string(), text: text.trim().to_string() });
            }
        }
        "seealso" => block.seealso = non_empty(),
        "family" => block.family = non_empty(),
        "inheritParams" => block.inherit_params.extend(words()),
        "inherit" => {
            let mut words = words();
            if let Some(source) = words.next() {
                block.inherit.push(Inherit { source, fields: words.collect() });
            }
        }
        "inheritDotParams" => block.inherit_dots.extend(words().next()),
        "inheritSection" => block.inherit_sections.extend(words().next()),
        "describeIn" => {
            let (parent, description) = split_first_word(content);
            if !parent.is_empty() {
                block.describe_in = Some(DescribeIn { parent: parent.to_string(), description: description.to_string() });
            }
        }
        "rdname" => block.rdname = words().next(),
        "template" => block.templates.extend(words().next()),
        "keywords" => block.keywords.extend(words()),
        "noRd" => block.no_rd = true,
        "export" => block.export = true,
        "md" => block.md = Some(true),
        "noMd" => block.md = Some(false),
        _ => {}
    }
}

fn split_first_word(content: &str) -> (&str, &str) {
    match content.split_once(char::is_whitespace) {
        Some((word, rest)) => (word, rest.trim()),
        None => (content, ""),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(lines: &[&str]) -> Block {
        parse_block(lines)
    }

    #[test]
    fn intro_paragraphs() {
        let block = parse(&["#' Title here", "#' continues", "#'", "#' Description.", "#'", "#' Details one.", "#'", "#' Details two."]);
        assert_eq!(block.title.as_deref(), Some("Title here continues"));
        assert_eq!(block.description.as_deref(), Some("Description."));
        assert_eq!(block.details.as_deref(), Some("Details one.\n\nDetails two."));
    }

    #[test]
    fn explicit_tags_override_intro() {
        let block = parse(&["#' @title T", "#' @description D", "#'   more", "#' @details X"]);
        assert_eq!(block.title.as_deref(), Some("T"));
        assert_eq!(block.description.as_deref(), Some("D\n  more"));
        assert_eq!(block.details.as_deref(), Some("X"));
    }

    #[test]
    fn multi_name_params_and_continuations() {
        let block = parse(&["#' @param x,y Shared", "#'   text", "#' @param `z` Zed"]);
        assert_eq!(block.params.len(), 2);
        assert_eq!(block.params[0].names, ["x", "y"]);
        assert_eq!(block.params[0].text, "Shared\n  text");
        assert_eq!(block.param("y"), Some("Shared\n  text"));
        assert_eq!(block.param("z"), Some("Zed"));
    }

    #[test]
    fn returns_alias_and_first_wins() {
        let block = parse(&["#' @returns A", "#' @return B"]);
        assert_eq!(block.returns.as_deref(), Some("A"));
    }

    #[test]
    fn section_splits_at_first_colon() {
        let block = parse(&["#' @section Warning:", "#' Do not: run.", "#' @section Bad title no colon"]);
        assert_eq!(block.sections, [Section { title: "Warning".into(), text: "Do not: run.".into() }]);
    }

    #[test]
    fn examples_keep_indentation() {
        let block = parse(&["#' @examples", "#' f(1)", "#' if (x) {", "#'   g()", "#' }"]);
        assert_eq!(block.examples.as_deref(), Some("f(1)\nif (x) {\n  g()\n}"));
    }

    #[test]
    fn example_paths() {
        let block = parse(&["#' @example inst/ex.R"]);
        assert_eq!(block.example_files, ["inst/ex.R"]);
    }

    #[test]
    fn inheritance_tags() {
        let block = parse(&[
            "#' @inheritParams a dplyr::mutate",
            "#' @inherit b params title",
            "#' @inheritDotParams c",
            "#' @inheritSection d Notes",
            "#' @describeIn p Does a thing",
            "#' @rdname page",
        ]);
        assert_eq!(block.inherit_params, ["a", "dplyr::mutate"]);
        assert_eq!(block.inherit, [Inherit { source: "b".into(), fields: vec!["params".into(), "title".into()] }]);
        assert_eq!(block.inherit_dots, ["c"]);
        assert_eq!(block.inherit_sections, ["d"]);
        assert_eq!(block.describe_in, Some(DescribeIn { parent: "p".into(), description: "Does a thing".into() }));
        assert_eq!(block.rdname.as_deref(), Some("page"));
    }

    #[test]
    fn flags_and_unknown_tags() {
        let block = parse(&["#' @export", "#' @noRd", "#' @md", "#' @keywords internal x", "#' @wat 1", "#' @template tpl"]);
        assert!(block.export && block.no_rd);
        assert_eq!(block.md, Some(true));
        assert_eq!(block.keywords, ["internal", "x"]);
        assert_eq!(block.templates, ["tpl"]);
        assert!(!block.has_content());
    }

    #[test]
    fn escaped_at_sign() {
        let block = parse(&["#' Mail me @@ home", "#' @param x Use @@name"]);
        assert_eq!(block.title.as_deref(), Some("Mail me @ home"));
        assert_eq!(block.param("x"), Some("Use @name"));
    }

    #[test]
    fn empty_block_has_no_content() {
        assert!(!parse(&["#'"]).has_content());
        assert!(!parse_block::<&str>(&[]).has_content());
    }

    #[test]
    fn code_fence_blank_lines_do_not_split() {
        let block = parse(&["#' T", "#'", "#' D", "#'", "#' ```r", "#' a", "#'", "#' b", "#' ```"]);
        assert_eq!(block.details.as_deref(), Some("```r\na\n\nb\n```"));
    }

    #[test]
    fn r_code_is_stripped_before_parsing() {
        let block = parse(&["#' T `r Sys.time()`", "#' @eval evil()", "#' @param x ok"]);
        assert_eq!(block.title.as_deref(), Some("T"));
        assert_eq!(block.param("x"), Some("ok"));
    }
}
