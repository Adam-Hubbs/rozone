mod common;

use proptest::prelude::*;
use rozone_core::Index;
use rozone_core::internals::TextMap;

/// R-ish fragments so random text often forms calls, blocks and pipes.
const FRAGMENTS: &[&str] = &[
    "f", "wmean", "x", "w", "(", ")", ", ", ",", " ", "\n", "\n\n", "#' ", "#'", "# ", "@param ", "@inheritParams ", "@rdname ",
    "@describeIn ", "@eval ", "@section T: ", "```{r}", "```", "`r 1`", "<-", "=", "<<-", "->", "function(", "{", "}", "[", "]",
    "[[", "|>", "%>%", "_", ".", "...", "\"", "'", "`", "é", "😀", "中", "::", "$", "@", "#", "1", "NULL", "\r\n", "\t",
];

fn r_text() -> impl Strategy<Value = String> {
    prop_oneof![
        ".{0,120}",
        prop::collection::vec(prop::sample::select(FRAGMENTS), 0..60).prop_map(|v| v.concat()),
    ]
}

fn all_queries(index: &Index, path: &str, offset: u32) {
    let _ = index.hover(path, offset);
    let _ = index.signature_help(path, offset);
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]

    #[test]
    fn queries_never_panic(text in r_text(), other in r_text(), offsets in prop::collection::vec(any::<u32>(), 8)) {
        let mut index = Index::new();
        index.update_file("/a.R", &text);
        index.update_file("/b.R", &other);
        let len = text.encode_utf16().count() as u32;
        for offset in offsets.iter().copied().chain(0..=len.min(150)).chain([len, len + 1, u32::MAX]) {
            all_queries(&index, "/a.R", offset);
        }
        let _ = index.documented_functions();
        let _ = index.documentation("f", Some("/a.R"));
        let _ = index.documentation("wmean", None);
        index.update_file("/a.R", &other);
        index.remove_file("/b.R");
    }

    #[test]
    fn prefix_of_a_valid_file_never_panics(cut in 0usize..2000) {
        let text = common::mark(&common::fixture("calls.R")).text;
        let mut end = cut.min(text.len());
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        let mut index = Index::new();
        index.update_file("/a.R", &text[..end]);
        let len = text[..end].encode_utf16().count() as u32;
        for offset in 0..=len {
            all_queries(&index, "/a.R", offset);
        }
    }

    #[test]
    fn manifest_parsing_never_panics(json in ".{0,200}") {
        let mut index = Index::new();
        let _ = index.load_manifest(&json);
    }

    #[test]
    fn utf16_byte_round_trip(text in r_text()) {
        let map = TextMap::new(&text);
        let mut utf16 = 0u32;
        for (byte, ch) in text.char_indices() {
            prop_assert_eq!(map.to_utf16(byte as u32), utf16);
            prop_assert_eq!(map.to_byte(utf16), byte as u32);
            utf16 += ch.len_utf16() as u32;
        }
        prop_assert_eq!(map.to_utf16(text.len() as u32), utf16);
        prop_assert_eq!(map.to_byte(utf16), text.len() as u32);
        prop_assert_eq!(map.len16(), utf16);
        // Any UTF-16 offset lands on a char boundary of the text.
        for u in 0..=utf16 + 2 {
            prop_assert!(text.is_char_boundary(map.to_byte(u) as usize));
        }
    }

    #[test]
    fn comments_in_other_statements_do_not_change_docs(garbage in "[^\n\r]{0,60}", in_body in any::<bool>()) {
        let base = "#' F title\n#' @param a A doc.\nf <- function(a) {\n  a\n}\n\n#' G title\n#' @param b B doc.\ng <- function(b) NULL\n";
        let noisy = if in_body {
            base.replace("  a\n", &format!("  a # {garbage}\n"))
        } else {
            base.replace("\n\n#' G", &format!("\n# {garbage}\n\n#' G"))
        };
        let docs = |text: &str| {
            let mut index = Index::new();
            index.update_file("/a.R", text);
            ["f", "g"].map(|name| index.documentation(name, Some("/a.R")))
        };
        prop_assert_eq!(docs(base), docs(&noisy));
    }
}
