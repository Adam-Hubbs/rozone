use air_r_parser::RParserOptions;
use air_r_syntax::{AnyRExpression, RBinaryExpression, RCall, RSyntaxNode};
use biome_rowan::{AstNode, AstNodeList, AstSeparatedList, TextSize};

#[derive(Debug)]
pub struct FunctionDoc {
    pub name: String,
    pub params: Vec<(String, Option<String>)>,
    roxygen: Vec<String>,
}


pub fn function_doc(expr: &AnyRExpression) -> Option<FunctionDoc> {
    let binary = expr.as_r_binary_expression()?;
    let op = binary.operator().ok()?;
    if !matches!(op.text_trimmed(), "<-" | "=" | "<<-") {
        return None;
    }
    let name = binary.left().ok()?.as_r_identifier()?.syntax().text_trimmed().to_string();
    let function = binary.right().ok()?;
    let function = function.as_r_function_definition()?;
    let params = function
        .parameters()
        .ok()?
        .items()
        .iter()
        .filter_map(Result::ok)
        .map(|p| {
            let name = p.name().map(|n| n.syntax().text_trimmed().to_string()).unwrap_or_default();
            let default = p.default().and_then(|d| d.value().ok()).map(|v| v.syntax().text_trimmed().to_string());
            (name, default)
        })
        .collect();
    Some(FunctionDoc { name, params, roxygen: leading_roxygen(binary) })
}

// Roxygen lines are leading trivia of the assignment's first token; a blank line
// (two newlines in a row) or a non-roxygen comment ends the block.
fn leading_roxygen(binary: &RBinaryExpression) -> Vec<String> {
    let Some(token) = binary.syntax().first_token() else { return Vec::new() };
    let mut block = Vec::new();
    let mut newlines = 0;
    for piece in token.leading_trivia().pieces() {
        if piece.is_comments() {
            let text = piece.text();
            if text.trim_start_matches('#').starts_with('\'') && newlines < 2 {
                block.push(text.to_string());
            } else {
                block.clear();
                if text.trim_start_matches('#').starts_with('\'') {
                    block.push(text.to_string());
                }
            }
            newlines = 0;
        } else if piece.is_newline() {
            newlines += 1;
        }
    }
    if newlines >= 2 { Vec::new() } else { block }
}

pub fn enclosing_call(root: &RSyntaxNode, offset: TextSize) -> Option<(String, usize)> {
    let token = root.token_at_offset(offset).left_biased()?;
    let call = token.ancestors().filter_map(RCall::cast).find(|call| {
        call.arguments().is_ok_and(|args| {
            let range = args.syntax().text_trimmed_range();
            range.start() < offset && offset <= range.end()
        })
    })?;
    let name = call.function().ok()?.syntax().text_trimmed().to_string();
    let args = call.arguments().ok()?;
    let index = args
        .items()
        .elements()
        .take_while(|el| el.trailing_separator().ok().flatten().is_some_and(|sep| sep.text_trimmed_range().end() <= offset))
        .count();
    Some((name, index))
}

pub fn documented_functions(contents: &str) -> Vec<FunctionDoc> {
    air_r_parser::parse(contents, RParserOptions::default())
        .tree()
        .statements()
        .iter()
        .filter_map(|stmt| stmt.as_r_expression_statement()?.expression().ok())
        .filter_map(|expr| function_doc(&expr))
        .collect()
}

// Minimal C ABI so the spike can be exercised from Node without wasm-bindgen.
#[unsafe(no_mangle)]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut buf = Vec::<u8>::with_capacity(len);
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

#[unsafe(no_mangle)]
pub extern "C" fn count_documented(ptr: *const u8, len: usize) -> u32 {
    let contents = unsafe { std::str::from_utf8_unchecked(std::slice::from_raw_parts(ptr, len)) };
    documented_functions(contents).iter().filter(|doc| !doc.roxygen.is_empty()).count() as u32
}

#[unsafe(no_mangle)]
pub extern "C" fn active_argument(ptr: *const u8, len: usize, offset: u32) -> i32 {
    let contents = unsafe { std::str::from_utf8_unchecked(std::slice::from_raw_parts(ptr, len)) };
    let parsed = air_r_parser::parse(contents, RParserOptions::default());
    enclosing_call(&parsed.syntax(), TextSize::from(offset)).map_or(-1, |(_, i)| i as i32)
}
