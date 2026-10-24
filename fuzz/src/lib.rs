//! Grammar-aware generator for R scripts with roxygen blocks.

use arbitrary::Arbitrary;

const NAMES: &[&str] = &[
    "f", "g", "x", "y", "data", "...", "`odd name`", "na.rm", "if_", "é", "日本", ".hidden",
];
const FRAGMENTS: &[&str] = &[
    "Some text.",
    "Uses `code` and \\code{x}.",
    "A \\emph{nested \\strong{tag}}.",
    "Unbalanced { brace",
    "\\link[pkg]{fn}",
    "emoji \u{1F600} and \u{e9}",
    "- item\n#' - item 2",
    "",
];

#[derive(Debug, Arbitrary)]
pub enum Tag {
    Title(u8),
    Description(u8),
    Details(u8),
    Param { name: u8, text: u8 },
    Return(u8),
    Examples(Vec<u8>),
    Section(u8),
    Rdname(u8),
    Export,
    Inherit(u8),
    UnknownTag(u8, u8),
    Raw(String),
}

#[derive(Debug, Arbitrary)]
pub struct Func {
    pub doc: Vec<Tag>,
    pub name: u8,
    pub params: Vec<(u8, Option<u8>)>,
    pub body_calls: Vec<(u8, Vec<u8>)>,
    pub blank_after_doc: bool,
    pub crlf: bool,
    pub arrow: u8,
}

#[derive(Debug, Arbitrary)]
pub struct Script {
    pub funcs: Vec<Func>,
    pub trailing_calls: Vec<(u8, Vec<(Option<u8>, u8)>)>,
    pub garbage_suffix: Option<String>,
}

fn name(i: u8) -> &'static str {
    NAMES[usize::from(i) % NAMES.len()]
}

fn frag(i: u8) -> &'static str {
    FRAGMENTS[usize::from(i) % FRAGMENTS.len()]
}

fn line(out: &mut String, s: &str) {
    for l in s.split('\n') {
        out.push_str("#' ");
        out.push_str(l);
        out.push('\n');
    }
}

impl Tag {
    fn render(&self, out: &mut String) {
        match self {
            Tag::Title(t) => line(out, frag(*t)),
            Tag::Description(t) => line(out, &format!("@description {}", frag(*t))),
            Tag::Details(t) => line(out, &format!("@details {}", frag(*t))),
            Tag::Param { name: n, text } => {
                line(out, &format!("@param {} {}", name(*n), frag(*text)));
            }
            Tag::Return(t) => line(out, &format!("@return {}", frag(*t))),
            Tag::Examples(ls) => {
                line(out, "@examples");
                for l in ls.iter().take(6) {
                    line(out, &format!("{}({})", name(*l), l));
                }
            }
            Tag::Section(t) => line(out, &format!("@section {}:\n{}", frag(*t), frag(*t))),
            Tag::Rdname(n) => line(out, &format!("@rdname {}", name(*n))),
            Tag::Export => line(out, "@export"),
            Tag::Inherit(n) => line(out, &format!("@inheritParams {}", name(*n))),
            Tag::UnknownTag(a, b) => line(out, &format!("@tag{} {}", a, frag(*b))),
            Tag::Raw(s) => line(out, s),
        }
    }
}

impl Script {
    pub fn render(&self) -> String {
        let mut out = String::new();
        for f in self.funcs.iter().take(16) {
            let mut block = String::new();
            for t in f.doc.iter().take(12) {
                t.render(&mut block);
            }
            if f.crlf {
                block = block.replace('\n', "\r\n");
            }
            out.push_str(&block);
            if f.blank_after_doc {
                out.push('\n');
            }
            let params = f
                .params
                .iter()
                .take(6)
                .map(|(n, d)| match d {
                    Some(d) => format!("{} = {}", name(*n), d),
                    None => name(*n).to_string(),
                })
                .collect::<Vec<_>>()
                .join(", ");
            let arrow = ["<-", "=", "<<-"][usize::from(f.arrow) % 3];
            out.push_str(&format!("{} {} function({}) {{\n", name(f.name), arrow, params));
            for (callee, args) in f.body_calls.iter().take(4) {
                let args = args.iter().take(4).map(u8::to_string).collect::<Vec<_>>();
                out.push_str(&format!("  {}({})\n", name(*callee), args.join(", ")));
            }
            out.push_str("}\n\n");
        }
        for (callee, args) in self.trailing_calls.iter().take(8) {
            let args = args
                .iter()
                .take(5)
                .map(|(n, v)| match n {
                    Some(n) => format!("{} = {}", name(*n), v),
                    None => v.to_string(),
                })
                .collect::<Vec<_>>()
                .join(", ");
            out.push_str(&format!("{}({})\n", name(*callee), args));
        }
        if let Some(g) = &self.garbage_suffix {
            out.push_str(g);
        }
        out
    }
}
