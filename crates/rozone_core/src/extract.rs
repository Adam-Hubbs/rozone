//! Top-level function definitions and their leading `#'` blocks.

use air_r_parser::RParserOptions;
use air_r_syntax::{AnyRExpression, RFunctionDefinition, RSyntaxNode};
use biome_rowan::{AstNode, AstNodeList, AstSeparatedList, TextRange};

use crate::roxygen::{Block, parse_block};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Formal {
    pub name: String,
    pub default: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Definition {
    pub name: String,
    /// The identifier being assigned to.
    pub name_range: TextRange,
    pub formals: Vec<Formal>,
    pub block: Option<Block>,
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
    Parsed { root: parse.syntax(), defs }
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
        formals: formals(&function),
        block: leading_block(binary.syntax()),
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
    let Ok(parameters) = function.parameters() else { return Vec::new() };
    parameters
        .items()
        .iter()
        .filter_map(Result::ok)
        .map(|param| Formal {
            name: param.name().map(|n| n.syntax().text_trimmed().to_string()).unwrap_or_default(),
            default: param
                .default()
                .and_then(|d| d.value().ok())
                .map(|v| v.syntax().text_trimmed().to_string()),
        })
        .collect()
}

pub fn unquote(name: &str) -> String {
    let inner = name.strip_prefix('`').and_then(|n| n.strip_suffix('`'));
    inner.unwrap_or(name).to_string()
}

/// Roxygen lines are leading trivia of the statement's first token; a blank
/// line or a non-roxygen comment ends the block.
fn leading_block(node: &RSyntaxNode) -> Option<Block> {
    let token = node.first_token()?;
    let mut block: Vec<String> = Vec::new();
    let mut newlines = 0;
    for piece in token.leading_trivia().pieces() {
        if piece.is_comments() {
            let text = piece.text();
            let is_roxygen = text.trim_start_matches('#').starts_with('\'');
            if !(is_roxygen && newlines < 2) {
                block.clear();
            }
            if is_roxygen {
                block.push(text.to_string());
            }
            newlines = 0;
        } else if piece.is_newline() {
            newlines += 1;
        }
    }
    if newlines >= 2 || block.is_empty() {
        return None;
    }
    Some(parse_block(&block))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn defs(text: &str) -> Vec<Definition> {
        parse(text).defs
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
        let d = &defs("f <- function(x, w = rep(1, length(x)), ...) NULL")[0];
        let got: Vec<_> = d.formals.iter().map(|f| (f.name.as_str(), f.default.as_deref())).collect();
        assert_eq!(got, [("x", None), ("w", Some("rep(1, length(x))")), ("...", None)]);
    }

    #[test]
    fn block_ends_at_blank_line() {
        let d = &defs("#' Doc\n\nf <- function() 1\n")[0];
        assert!(d.block.is_none());
        let d = &defs("#' Doc\nf <- function() 1\n")[0];
        assert_eq!(d.block.as_ref().unwrap().title.as_deref(), Some("Doc"));
    }

    #[test]
    fn plain_comment_between_ends_block() {
        let d = &defs("#' Doc\n# note\nf <- function() 1\n")[0];
        assert!(d.block.is_none());
        let d = &defs("# note\n#' Doc\nf <- function() 1\n")[0];
        assert!(d.block.is_some());
    }

    #[test]
    fn blank_line_inside_comments_restarts_block() {
        let d = &defs("#' Old\n\n#' New\nf <- function() 1\n")[0];
        assert_eq!(d.block.as_ref().unwrap().title.as_deref(), Some("New"));
    }

    #[test]
    fn block_for_right_assignment_is_on_the_paren() {
        let d = &defs("#' Doc\n(function() 1) -> f\n")[0];
        assert!(d.block.is_some());
    }

    #[test]
    fn first_statement_in_file_has_its_block() {
        let d = &defs("#' First\nf <- function() 1\n")[0];
        assert!(d.block.is_some());
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
        let d = &defs("#' Doc\r\nf <- function() 1\r\n")[0];
        assert_eq!(d.block.as_ref().unwrap().title.as_deref(), Some("Doc"));
    }
}
