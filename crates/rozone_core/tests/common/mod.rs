#![allow(dead_code)]

use std::fmt::Write;

use rozone_core::{Hover, Index, SignatureHelp};

pub const MARKER: char = '¦';

/// Text with every `¦` removed, and the UTF-16 offsets where they were.
pub struct Marked {
    pub text: String,
    pub offsets: Vec<u32>,
}

pub fn mark(source: &str) -> Marked {
    let mut text = String::new();
    let mut offsets = Vec::new();
    let mut utf16 = 0u32;
    for ch in source.chars() {
        if ch == MARKER {
            offsets.push(utf16);
        } else {
            text.push(ch);
            utf16 += ch.len_utf16() as u32;
        }
    }
    Marked { text, offsets }
}

pub fn fixture(name: &str) -> String {
    let path = format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"))
}

/// `line:col` (columns in UTF-16 units) and the source line with a caret.
fn locate(text: &str, offset: u32) -> (usize, u32, String) {
    let mut start = 0u32;
    for (i, line) in text.split('\n').enumerate() {
        let len = line.encode_utf16().count() as u32;
        if offset <= start + len {
            let col = offset - start;
            let units: Vec<u16> = line.encode_utf16().collect();
            let before = String::from_utf16_lossy(&units[..col as usize]);
            let after = String::from_utf16_lossy(&units[col as usize..]);
            return (i + 1, col, format!("{before}{MARKER}{after}"));
        }
        start += len + 1;
    }
    (0, 0, String::new())
}

fn fmt_hover(out: &mut String, hover: Option<&Hover>) {
    match hover {
        None => out.push_str("hover: none\n"),
        Some(h) => {
            writeln!(
                out,
                "hover: {:?} {} range={}..{} source={:?}",
                h.kind, h.name, h.range.start, h.range.end, h.source
            )
            .unwrap();
            for line in h.markdown.lines() {
                writeln!(out, "  | {line}").unwrap();
            }
        }
    }
}

fn fmt_signature(out: &mut String, help: Option<&SignatureHelp>) {
    match help {
        None => out.push_str("signature: none\n"),
        Some(s) => {
            let units: Vec<u16> = s.label.encode_utf16().collect();
            let active = s.active_parameter.map_or("null".to_string(), |i| {
                let [start, end] = s.parameters[i as usize].label;
                format!(
                    "{i} ({})",
                    String::from_utf16_lossy(&units[start as usize..end as usize])
                )
            });
            writeln!(out, "signature: {} active={active}", s.label).unwrap();
        }
    }
}

/// A readable dump of everything the index says about one fixture: the
/// documented functions, each full documentation page, and hover plus
/// signature help at every `¦` marker.
pub fn report(name: &str) -> String {
    let marked = mark(&fixture(name));
    let mut index = Index::new();
    index.update_file(name, &marked.text);

    let mut out = String::new();
    out.push_str("# documented functions\n");
    for f in index.documented_functions() {
        writeln!(
            out,
            "{} {}..{} title={:?}",
            f.name, f.range.start, f.range.end, f.title
        )
        .unwrap();
    }
    for f in index.documented_functions() {
        writeln!(out, "\n# documentation({})", f.name).unwrap();
        out.push_str(&index.documentation(&f.name, Some(name)).unwrap_or_default());
        out.push('\n');
        let hover = index.hover(name, f.range.start);
        writeln!(out, "\n# hover at definition of {}", f.name).unwrap();
        fmt_hover(&mut out, hover.as_ref());
    }
    for &offset in &marked.offsets {
        let (line, col, shown) = locate(&marked.text, offset);
        writeln!(out, "\n# {line}:{col}  {shown}").unwrap();
        fmt_hover(&mut out, index.hover(name, offset).as_ref());
        fmt_signature(&mut out, index.signature_help(name, offset).as_ref());
    }
    out
}
