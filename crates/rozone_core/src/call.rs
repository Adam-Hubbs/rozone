//! Cursor-driven syntax queries: the identifier under the cursor, the
//! enclosing call, and R argument matching.

use air_r_syntax::{RBinaryExpression, RSyntaxKind, RSyntaxNode, RSyntaxToken};
use biome_rowan::{AstNode, NodeOrToken, TextRange, TextSize, TokenAtOffset};

use crate::extract::unquote;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Usage {
    /// The callee of `name(...)`.
    Callee,
    /// The target of an assignment; only meaningful for known definitions.
    AssignTarget,
    Bare,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdentAt {
    pub name: String,
    pub range: TextRange,
    pub usage: Usage,
}

/// The plain identifier at `offset`. Names that are not references to a
/// binding (`pkg::fn`, `x$fn`, `f(name = )`, parameter names) give `None`.
pub fn ident_at(root: &RSyntaxNode, offset: TextSize) -> Option<IdentAt> {
    let candidates = match root.token_at_offset(offset) {
        TokenAtOffset::None => return None,
        TokenAtOffset::Single(token) => vec![token],
        TokenAtOffset::Between(left, right) => vec![right, left],
    };
    let token = candidates.into_iter().find(|token| {
        let range = token.text_trimmed_range();
        token.kind() == RSyntaxKind::IDENT && range.start() <= offset && offset <= range.end()
    })?;
    let node = token.parent()?;
    if node.kind() != RSyntaxKind::R_IDENTIFIER {
        return None;
    }
    let usage = match node.parent() {
        None => Usage::Bare,
        Some(parent) => match parent.kind() {
            RSyntaxKind::R_CALL if parent.first_child().as_ref() == Some(&node) => Usage::Callee,
            RSyntaxKind::R_NAMESPACE_EXPRESSION
            | RSyntaxKind::R_ARGUMENT_NAME_CLAUSE
            | RSyntaxKind::R_PARAMETER => return None,
            RSyntaxKind::R_EXTRACT_EXPRESSION if parent.last_child().as_ref() == Some(&node) => {
                return None;
            }
            RSyntaxKind::R_BINARY_EXPRESSION => binary_usage(&parent, &node),
            _ => Usage::Bare,
        },
    };
    Some(IdentAt {
        name: unquote(token.text_trimmed()),
        range: token.text_trimmed_range(),
        usage,
    })
}

fn binary_usage(binary: &RSyntaxNode, ident: &RSyntaxNode) -> Usage {
    let Some(op) = operator_of(binary) else {
        return Usage::Bare;
    };
    let is_left = binary.first_child().as_ref() == Some(ident);
    match op.kind() {
        RSyntaxKind::ASSIGN | RSyntaxKind::SUPER_ASSIGN | RSyntaxKind::EQUAL if is_left => {
            Usage::AssignTarget
        }
        RSyntaxKind::ASSIGN_RIGHT | RSyntaxKind::SUPER_ASSIGN_RIGHT if !is_left => {
            Usage::AssignTarget
        }
        _ => Usage::Bare,
    }
}

fn operator_of(binary: &RSyntaxNode) -> Option<RSyntaxToken> {
    binary.children_with_tokens().find_map(|el| match el {
        NodeOrToken::Token(token) => Some(token),
        NodeOrToken::Node(_) => None,
    })
}

/// A call whose argument list contains the cursor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallSite {
    pub callee: String,
    /// Argument names in call order. A piped left-hand side comes first and
    /// is unnamed.
    pub arg_names: Vec<Option<String>>,
    /// Index into `arg_names` of the argument under the cursor.
    pub active_arg: usize,
}

/// The innermost call enclosing `offset`, or `None` when that call's callee is
/// not a plain identifier.
pub fn call_at(root: &RSyntaxNode, offset: TextSize) -> Option<CallSite> {
    let token = match root.token_at_offset(offset) {
        TokenAtOffset::None => return None,
        TokenAtOffset::Single(token) => token,
        TokenAtOffset::Between(left, _) => left,
    };
    let token = if token.kind() == RSyntaxKind::EOF {
        token.prev_token()?
    } else {
        token
    };
    let args = token.ancestors().find(|node| {
        node.kind() == RSyntaxKind::R_CALL_ARGUMENTS && contains_cursor(node, offset)
    })?;
    let call = args.parent().filter(|n| n.kind() == RSyntaxKind::R_CALL)?;
    let callee = call
        .first_child()
        .filter(|n| n.kind() == RSyntaxKind::R_IDENTIFIER)?;

    let list = args
        .children()
        .find(|n| n.kind() == RSyntaxKind::R_ARGUMENT_LIST);
    let mut slots = Vec::new();
    let mut commas_before = 0;
    if let Some(list) = &list {
        for element in list.children_with_tokens() {
            match element {
                NodeOrToken::Node(arg) => slots.push(arg),
                NodeOrToken::Token(comma) => {
                    commas_before += usize::from(comma.text_trimmed_range().end() <= offset)
                }
            }
        }
    }
    let cursor = commas_before.min(slots.len().saturating_sub(1));
    let mut arg_names: Vec<Option<String>> = slots.iter().map(argument_name).collect();
    if arg_names.is_empty() {
        arg_names.push(None);
    }

    let injected = pipe_injects_lhs(&call, &slots);
    if injected {
        arg_names.insert(0, None);
    }
    Some(CallSite {
        callee: unquote(&callee.text_trimmed().to_string()),
        arg_names,
        active_arg: cursor + usize::from(injected),
    })
}

/// Strictly between the parentheses; a missing `)` (unfinished code) extends
/// the call to the end of the file.
fn contains_cursor(args: &RSyntaxNode, offset: TextSize) -> bool {
    let mut open = None;
    let mut close = None;
    for element in args.children_with_tokens() {
        if let NodeOrToken::Token(token) = element {
            match token.kind() {
                RSyntaxKind::L_PAREN => open = Some(token.text_trimmed_range().end()),
                RSyntaxKind::R_PAREN => close = Some(token.text_trimmed_range().start()),
                _ => {}
            }
        }
    }
    open.is_some_and(|open| open <= offset) && close.is_none_or(|close| offset <= close)
}

fn argument_name(arg: &RSyntaxNode) -> Option<String> {
    let clause = arg
        .first_child()
        .filter(|n| n.kind() == RSyntaxKind::R_ARGUMENT_NAME_CLAUSE)?;
    let name = clause.first_child()?;
    let text = name.text_trimmed().to_string();
    let trimmed = text
        .strip_prefix('"')
        .and_then(|t| t.strip_suffix('"'))
        .or_else(|| text.strip_prefix('\'').and_then(|t| t.strip_suffix('\'')))
        .unwrap_or(&text);
    Some(unquote(trimmed))
}

fn argument_value(arg: &RSyntaxNode) -> Option<RSyntaxNode> {
    arg.children()
        .find(|n| n.kind() != RSyntaxKind::R_ARGUMENT_NAME_CLAUSE)
}

/// `lhs |> f(args)` and `lhs %>% f(args)` pass `lhs` as the first positional
/// argument unless the placeholder (`_` / `.`) says where it goes.
fn pipe_injects_lhs(call: &RSyntaxNode, slots: &[RSyntaxNode]) -> bool {
    let Some(binary) = call.parent().and_then(RBinaryExpression::cast) else {
        return false;
    };
    let is_rhs = binary.right().is_ok_and(|right| right.syntax() == call);
    let Ok(op) = binary.operator() else {
        return false;
    };
    if !is_rhs {
        return false;
    }
    let placeholder = match op.text_trimmed() {
        "|>" => "_",
        "%>%" => ".",
        _ => return false,
    };
    !slots.iter().filter_map(argument_value).any(|value| {
        value.kind() == RSyntaxKind::R_IDENTIFIER && value.text_trimmed() == placeholder
    })
}

/// R's argument matching: exact names, then unique partial names (only for
/// formals before `...`), then positional. Returns, for each argument, the
/// index of the formal it binds to. Unmatched named arguments and surplus
/// positional ones bind to `...` when there is one.
pub fn match_args<F: AsRef<str>>(formals: &[F], args: &[Option<String>]) -> Vec<Option<usize>> {
    let dots = formals.iter().position(|f| f.as_ref() == "...");
    let mut bound: Vec<Option<usize>> = vec![None; args.len()];
    let mut taken = vec![false; formals.len()];

    for (i, name) in args.iter().enumerate() {
        let Some(name) = name else { continue };
        let exact = formals
            .iter()
            .enumerate()
            .find(|(j, f)| !taken[*j] && f.as_ref() != "..." && f.as_ref() == name);
        if let Some((j, _)) = exact {
            bound[i] = Some(j);
            taken[j] = true;
        }
    }

    let partial_limit = dots.unwrap_or(formals.len());
    for (i, name) in args.iter().enumerate() {
        let Some(name) = name else { continue };
        if bound[i].is_some() || name.is_empty() {
            continue;
        }
        let mut candidates = (0..partial_limit)
            .filter(|&j| !taken[j] && formals[j].as_ref().starts_with(name.as_str()));
        if let (Some(j), None) = (candidates.next(), candidates.next()) {
            bound[i] = Some(j);
            taken[j] = true;
        }
    }

    let mut next = 0;
    let mut in_dots = false;
    for (i, name) in args.iter().enumerate() {
        if bound[i].is_some() {
            continue;
        }
        if name.is_some() {
            bound[i] = dots;
            continue;
        }
        if !in_dots {
            while next < formals.len() && taken[next] {
                next += 1;
            }
            in_dots = Some(next) == dots;
        }
        if in_dots {
            bound[i] = dots;
        } else if next < formals.len() {
            bound[i] = Some(next);
            taken[next] = true;
        }
    }
    bound
}

#[cfg(test)]
mod tests {
    use air_r_parser::RParserOptions;

    use super::*;

    fn names(args: &[&str]) -> Vec<Option<String>> {
        args.iter()
            .map(|a| (!a.is_empty()).then(|| a.to_string()))
            .collect()
    }

    fn matched(formals: &[&str], args: &[&str]) -> Vec<Option<usize>> {
        match_args(formals, &names(args))
    }

    #[test]
    fn positional() {
        assert_eq!(matched(&["x", "w"], &["", ""]), [Some(0), Some(1)]);
        assert_eq!(
            matched(&["x", "w"], &["", "", ""]),
            [Some(0), Some(1), None]
        );
    }

    #[test]
    fn exact_names_take_precedence_over_position() {
        assert_eq!(
            matched(&["x", "w", "na.rm"], &["w", ""]),
            [Some(1), Some(0)]
        );
        assert_eq!(
            matched(&["x", "w", "na.rm"], &["", "x"]),
            [Some(1), Some(0)]
        );
    }

    #[test]
    fn partial_names() {
        assert_eq!(matched(&["x", "na.rm", "names"], &["na."]), [Some(1)]);
        assert_eq!(
            matched(&["x", "na.rm", "names"], &["n"]),
            [None],
            "ambiguous partial"
        );
        assert_eq!(matched(&["x", "na.rm", "names"], &["nam"]), [Some(2)]);
    }

    #[test]
    fn exact_beats_partial() {
        assert_eq!(matched(&["n", "name"], &["n", "na"]), [Some(0), Some(1)]);
        assert_eq!(matched(&["name", "n"], &["n", ""]), [Some(1), Some(0)]);
    }

    #[test]
    fn partial_does_not_apply_after_dots() {
        assert_eq!(matched(&["x", "...", "na.rm"], &["na"]), [Some(1)]);
        assert_eq!(matched(&["x", "...", "na.rm"], &["na.rm"]), [Some(2)]);
    }

    #[test]
    fn dots_absorb_extra_positionals() {
        let formals = ["x", "...", "na.rm"];
        assert_eq!(
            matched(&formals, &["", "", "", ""]),
            [Some(0), Some(1), Some(1), Some(1)]
        );
        assert_eq!(
            matched(&formals, &["", "", "na.rm"]),
            [Some(0), Some(1), Some(2)]
        );
    }

    #[test]
    fn named_without_match_goes_to_dots_or_nowhere() {
        assert_eq!(matched(&["x", "..."], &["", "zzz"]), [Some(0), Some(1)]);
        assert_eq!(matched(&["x", "w"], &["", "zzz"]), [Some(0), None]);
    }

    #[test]
    fn positional_skips_names_already_taken() {
        assert_eq!(
            matched(&["x", "y", "z"], &["y", "", ""]),
            [Some(1), Some(0), Some(2)]
        );
    }

    #[test]
    fn leading_dots_swallow_all_positionals() {
        assert_eq!(
            matched(&["...", "sep"], &["", "", "sep"]),
            [Some(0), Some(0), Some(1)]
        );
    }

    #[test]
    fn no_formals() {
        assert_eq!(matched(&[], &["", "a"]), [None, None]);
    }

    #[test]
    fn duplicate_exact_name_overflows_into_dots() {
        assert_eq!(matched(&["x", "..."], &["x", "x"]), [Some(0), Some(1)]);
    }

    fn site(src: &str) -> Option<CallSite> {
        let offset = src.find('¦').expect("cursor marker");
        let text = src.replacen('¦', "", 1);
        let root = air_r_parser::parse(&text, RParserOptions::default()).syntax();
        call_at(&root, TextSize::from(offset as u32))
    }

    #[test]
    fn call_site_basics() {
        let s = site("wm(x, w¦)").unwrap();
        assert_eq!(
            (s.callee.as_str(), s.active_arg, s.arg_names.len()),
            ("wm", 1, 2)
        );
    }

    #[test]
    fn cursor_boundaries() {
        assert!(site("wm¦(x)").is_none());
        assert_eq!(site("wm(¦x)").unwrap().active_arg, 0);
        assert_eq!(site("wm(x¦)").unwrap().active_arg, 0);
        assert!(site("wm(x)¦").is_none());
        assert_eq!(site("wm(x,¦ y)").unwrap().active_arg, 1);
        assert_eq!(site("wm(x ¦, y)").unwrap().active_arg, 0);
        assert_eq!(site("wm(¦)").unwrap().active_arg, 0);
    }

    #[test]
    fn innermost_call_wins() {
        let s = site("wm(x, rep(1, ¦))").unwrap();
        assert_eq!((s.callee.as_str(), s.active_arg), ("rep", 1));
        let s = site("wm(rep(1), ¦)").unwrap();
        assert_eq!((s.callee.as_str(), s.active_arg), ("wm", 1));
    }

    #[test]
    fn unclosed_calls() {
        assert_eq!(site("wm(x, w¦").unwrap().active_arg, 1);
        assert_eq!(site("wm(na¦").unwrap().active_arg, 0);
        assert_eq!(site("wm(x,\n  ¦").unwrap().active_arg, 1);
    }

    #[test]
    fn non_identifier_callees() {
        assert!(site("pkg::f(¦)").is_none());
        assert!(site("x$f(¦)").is_none());
    }

    #[test]
    fn named_and_empty_arguments() {
        let s = site("f(a, , b = ¦)").unwrap();
        assert_eq!(s.arg_names, [None, None, Some("b".to_string())]);
        assert_eq!(s.active_arg, 2);
    }

    #[test]
    fn pipes() {
        let s = site("x |> f(¦)").unwrap();
        assert_eq!((s.arg_names.len(), s.active_arg), (2, 1));
        let s = site("x |> f(y = _, ¦)").unwrap();
        assert_eq!((s.arg_names.len(), s.active_arg), (2, 1));
        let s = site("x %>% f(¦)").unwrap();
        assert_eq!((s.arg_names.len(), s.active_arg), (2, 1));
        let s = site("x %>% f(y, .¦)").unwrap();
        assert_eq!((s.arg_names.len(), s.active_arg), (2, 1));
        let s = site("x %>% f(g(.), ¦)").unwrap();
        assert_eq!((s.arg_names.len(), s.active_arg), (3, 2));
        let s = site("f(¦) |> g()").unwrap();
        assert_eq!(s.arg_names.len(), 1);
        let s = site("a |> b() |> f(¦)").unwrap();
        assert_eq!(s.arg_names.len(), 2);
    }

    #[test]
    fn identifier_classification() {
        let at = |src: &str| {
            let offset = src.find('¦').unwrap();
            let text = src.replacen('¦', "", 1);
            let root = air_r_parser::parse(&text, RParserOptions::default()).syntax();
            ident_at(&root, TextSize::from(offset as u32)).map(|i| (i.name, i.usage))
        };
        assert_eq!(at("wm¦ean(1)"), Some(("wmean".into(), Usage::Callee)));
        assert_eq!(at("map(xs, wm¦ean)"), Some(("wmean".into(), Usage::Bare)));
        assert_eq!(
            at("wm¦ean <- function() 1"),
            Some(("wmean".into(), Usage::AssignTarget))
        );
        assert_eq!(at("pkg::wm¦ean(1)"), None);
        assert_eq!(at("x$wm¦ean(1)"), None);
        assert_eq!(at("x@wm¦ean"), None);
        assert_eq!(at("f(wm¦ean = 1)"), None);
        assert_eq!(at("function(wm¦ean) 1"), None);
        assert_eq!(at("\"wm¦ean\""), None);
        assert_eq!(at("# wm¦ean"), None);
        assert_eq!(at("wmean¦(1)"), Some(("wmean".into(), Usage::Callee)));
        assert_eq!(at("wmean (¦1)"), None);
        assert_eq!(at("wm¦ean$x"), Some(("wmean".into(), Usage::Bare)));
    }
}
