//! Top-level function definitions and their leading `#'` blocks.

use air_r_parser::RParserOptions;
use std::cell::OnceCell;

use air_r_syntax::{AnyRExpression, RFunctionDefinition, RSyntaxNode};
use biome_rowan::{AstNode, AstNodeList, AstSeparatedList, TextRange};

use crate::roxygen::{Block, parse_block};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Formal {
    pub name: String,
    pub default: Option<String>,
}

/// Formals and the roxygen block are derived on first use: most definitions
/// are never queried.
#[derive(Debug, Clone)]
pub struct Definition {
    pub name: String,
    /// The identifier being assigned to.
    pub name_range: TextRange,
    function: RFunctionDefinition,
    block_span: Option<TextRange>,
    formals: OnceCell<Vec<Formal>>,
    block: OnceCell<Option<Block>>,
}

impl Definition {
    pub fn formals(&self) -> &[Formal] {
        self.formals.get_or_init(|| formals(&self.function))
    }

    /// The parsed leading `#'` block. `text` is the text the definition was
    /// extracted from.
    pub fn block(&self, text: &str) -> Option<&Block> {
        self.block
            .get_or_init(|| {
                let span = self.block_span?;
                let raw = text.get(usize::from(span.start())..usize::from(span.end()))?;
                let lines: Vec<&str> = raw
                    .lines()
                    .map(str::trim_start)
                    .filter(|l| l.starts_with('#'))
                    .collect();
                Some(parse_block(&lines))
            })
            .as_ref()
    }

    /// The raw text of the attached `#'` block, if any.
    pub fn block_text<'t>(&self, text: &'t str) -> &'t str {
        self.block_span
            .and_then(|span| text.get(usize::from(span.start())..usize::from(span.end())))
            .unwrap_or_default()
    }

    /// Exact source of the argument list, parentheses included.
    pub fn params_text(&self) -> String {
        self.function
            .parameters()
            .map(|p| p.syntax().text_trimmed().to_string())
            .unwrap_or_default()
    }

    /// Whether the raw block mentions `tag`; lets the index find `@rdname` and
    /// `@describeIn` without parsing every block.
    pub fn block_mentions(&self, text: &str, tag: &str) -> bool {
        self.block_span
            .and_then(|span| text.get(usize::from(span.start())..usize::from(span.end())))
            .is_some_and(|raw| raw.contains(tag))
    }
}

pub struct Parsed {
    pub root: RSyntaxNode,
    pub defs: Vec<Definition>,
}

pub fn parse(text: &str) -> Parsed {
    let parse = air_r_parser::parse(text, RParserOptions::default());
    let defs = parse
        .tree()
        .statements()
        .iter()
        .filter_map(|stmt| stmt.as_r_expression_statement()?.expression().ok())
        .filter_map(|expr| definition(&expr))
        .collect();
    Parsed {
        root: parse.syntax(),
        defs,
    }
}

/// `name <- function`, `name = function`, `name <<- function`, and the
/// right-assignments `(function(...) ...) -> name`. Without parentheses
/// `function(x) x -> name` parses (as in R) as a function whose body assigns,
/// so it is not a definition.
fn definition(expr: &AnyRExpression) -> Option<Definition> {
    let binary = expr.as_r_binary_expression()?;
    let op = binary.operator().ok()?;
    let (target, value) = match op.text_trimmed() {
        "<-" | "=" | "<<-" => (binary.left().ok()?, binary.right().ok()?),
        "->" | "->>" => (binary.right().ok()?, binary.left().ok()?),
        _ => return None,
    };
    let ident = target.as_r_identifier()?;
    let function = function_of(value)?;
    let name = unquote(&ident.syntax().text_trimmed().to_string());
    Some(Definition {
        name,
        name_range: ident.syntax().text_trimmed_range(),
        function,
        block_span: leading_block_span(binary.syntax()),
        formals: OnceCell::new(),
        block: OnceCell::new(),
    })
}

fn function_of(mut expr: AnyRExpression) -> Option<RFunctionDefinition> {
    loop {
        match expr {
            AnyRExpression::RFunctionDefinition(function) => return Some(function),
            AnyRExpression::RParenthesizedExpression(paren) => expr = paren.body().ok()?,
            _ => return None,
        }
    }
}

fn formals(function: &RFunctionDefinition) -> Vec<Formal> {
    let Ok(parameters) = function.parameters() else {
        return Vec::new();
    };
    parameters
        .items()
        .iter()
        .filter_map(Result::ok)
        .map(|param| Formal {
            name: param
                .name()
                .map(|n| n.syntax().text_trimmed().to_string())
                .unwrap_or_default(),
            default: param
                .default()
                .and_then(|d| d.value().ok())
                .map(|v| v.syntax().text_trimmed().to_string()),
        })
        .collect()
}

/// Everything in a file that can change roxygen2's output, as one
/// unambiguous string (length-prefixed records); see contracts §0.
pub fn doc_canonical(text: &str, root: &RSyntaxNode) -> String {
    use std::fmt::Write;
    let mut out = String::new();
    let mut record = |tag: char, body: &str| {
        let _ = writeln!(out, "{tag}{}:{body}", body.len());
    };
    for line in text.lines() {
        let line_start = line.trim_start();
        if line_start.starts_with('#') && line_start.trim_start_matches('#').starts_with('\'') {
            record('R', line);
        }
    }
    let Some(root) = air_r_syntax::RRoot::cast(root.clone()) else {
        return out;
    };
    for stmt in root.statements().iter() {
        let Some(expr) = stmt
            .as_r_expression_statement()
            .and_then(|s| s.expression().ok())
        else {
            continue;
        };
        if let Some(def) = definition(&expr) {
            record(
                'D',
                &format!(
                    "{}\u{1f}{}\u{1f}{}",
                    def.block_text(text),
                    def.name,
                    def.params_text()
                ),
            );
        } else if let Some(leading) = roxygen_leading(expr.syntax()) {
            record(
                'X',
                &format!("{leading}\u{1f}{}", expr.syntax().text_trimmed()),
            );
        }
    }
    out
}

/// The statement's leading comments and line breaks when they include a `#'`
/// line, attached or not. Blank lines matter: they decide what roxygen2 keeps.
fn roxygen_leading(node: &RSyntaxNode) -> Option<String> {
    let token = node.first_token()?;
    let pieces = token.leading_trivia();
    let has_roxygen = pieces
        .pieces()
        .any(|p| p.is_comments() && p.text().trim_start_matches('#').starts_with('\''));
    has_roxygen.then(|| pieces.pieces().map(|p| p.text().to_string()).collect())
}

pub fn unquote(name: &str) -> String {
    let inner = name.strip_prefix('`').and_then(|n| n.strip_suffix('`'));
    inner.unwrap_or(name).to_string()
}

/// Roxygen lines are leading trivia of the statement's first token; a blank
/// line or a non-roxygen comment ends the block. Returns the text span from
/// the first to the last `#'` line.
fn leading_block_span(node: &RSyntaxNode) -> Option<TextRange> {
    let token = node.first_token()?;
    let mut span: Option<TextRange> = None;
    let mut newlines = 0;
    for piece in token.leading_trivia().pieces() {
        if piece.is_comments() {
            let is_roxygen = piece.text().trim_start_matches('#').starts_with('\'');
            if !(is_roxygen && newlines < 2) {
                span = None;
            }
            if is_roxygen {
                let range = piece.text_range();
                span = Some(span.map_or(range, |s| s.cover(range)));
            }
            newlines = 0;
        } else if piece.is_newline() {
            newlines += 1;
        }
    }
    if newlines >= 2 { None } else { span }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn defs(text: &str) -> Vec<Definition> {
        parse(text).defs
    }

    fn block_of(text: &str) -> Option<Block> {
        parse(text).defs[0].block(text).cloned()
    }

    fn names(text: &str) -> Vec<String> {
        defs(text).into_iter().map(|d| d.name).collect()
    }

    #[test]
    fn assignment_forms() {
        let text = "a <- function() 1\nb = function() 1\nc <<- function() 1\n(function() 1) -> d\n(function() 1) ->> e\n";
        assert_eq!(names(text), ["a", "b", "c", "d", "e"]);
    }

    #[test]
    fn unparenthesised_right_assignment_is_not_a_definition() {
        assert_eq!(names("function(x) x -> g\n"), Vec::<String>::new());
    }

    #[test]
    fn parenthesised_function_on_the_right() {
        assert_eq!(names("f <- (function(x) x)\n"), ["f"]);
    }

    #[test]
    fn non_top_level_and_non_functions_are_ignored() {
        let text = "g <- function() {\n  inner <- function() 1\n}\nx <- 1\nif (TRUE) h <- function() 1\nk <- c(1)\n";
        assert_eq!(names(text), ["g"]);
    }

    #[test]
    fn formals_with_defaults() {
        let defs = defs("f <- function(x, w = rep(1, length(x)), ...) NULL");
        let got: Vec<_> = defs[0]
            .formals()
            .iter()
            .map(|f| (f.name.as_str(), f.default.as_deref()))
            .collect();
        assert_eq!(
            got,
            [("x", None), ("w", Some("rep(1, length(x))")), ("...", None)]
        );
    }

    #[test]
    fn block_ends_at_blank_line() {
        assert!(block_of("#' Doc\n\nf <- function() 1\n").is_none());
        assert_eq!(
            block_of("#' Doc\nf <- function() 1\n")
                .unwrap()
                .title
                .as_deref(),
            Some("Doc")
        );
    }

    #[test]
    fn plain_comment_between_ends_block() {
        assert!(block_of("#' Doc\n# note\nf <- function() 1\n").is_none());
        assert!(block_of("# note\n#' Doc\nf <- function() 1\n").is_some());
    }

    #[test]
    fn blank_line_inside_comments_restarts_block() {
        assert_eq!(
            block_of("#' Old\n\n#' New\nf <- function() 1\n")
                .unwrap()
                .title
                .as_deref(),
            Some("New")
        );
    }

    #[test]
    fn block_for_right_assignment_is_on_the_paren() {
        assert!(block_of("#' Doc\n(function() 1) -> f\n").is_some());
    }

    #[test]
    fn first_statement_in_file_has_its_block() {
        assert!(block_of("#' First\nf <- function() 1\n").is_some());
    }

    #[test]
    fn survives_broken_statements() {
        let text = "#' A\na <- function() 1\nx <- 1 +\n  oops )\n\n#' B\nb <- function() 2\nfoo(1,,\n)))\n#' C\nc <- function() 3\n";
        assert_eq!(names(text), ["a", "b", "c"]);
    }

    #[test]
    fn backtick_names_are_unquoted() {
        assert_eq!(names("`my f` <- function() 1\n"), ["my f"]);
    }

    #[test]
    fn crlf_line_endings() {
        assert_eq!(
            block_of("#' Doc\r\nf <- function() 1\r\n")
                .unwrap()
                .title
                .as_deref(),
            Some("Doc")
        );
    }
}
