//! Panic-freedom: arbitrary text, edits and offsets through the public API.
#![no_main]

use arbitrary::Arbitrary;
use libfuzzer_sys::fuzz_target;
use rozone_core::Index;

#[derive(Debug, Arbitrary)]
struct Input {
    text: String,
    edit: Option<String>,
    offsets: Vec<u32>,
    names: Vec<String>,
}

fn query_all(index: &Index, path: &str, len: u32, input: &Input) {
    // Raw offsets plus length-relative ones: splitting a surrogate pair or
    // landing past the end are the interesting UTF-16 cases.
    let probes = input
        .offsets
        .iter()
        .take(64)
        .flat_map(|&o| [o, o % (len + 3)]);
    for offset in probes {
        let _ = index.hover(path, offset);
        let _ = index.signature_help(path, offset);
    }
    for name in input.names.iter().take(8) {
        let _ = index.documentation(name, Some(path));
        let _ = index.documentation(name, None);
    }
    let _ = index.documented_functions();
}

fuzz_target!(|input: Input| {
    let path = "/fuzz/a.R";
    let mut index = Index::new();
    index.update_file(path, &input.text);
    let len = input.text.encode_utf16().count() as u32;
    query_all(&index, path, len, &input);

    if let Some(edit) = &input.edit {
        index.update_file(path, edit);
        let len = edit.encode_utf16().count() as u32;
        query_all(&index, path, len, &input);
    }
    let _ = index.hover("/fuzz/missing.R", 0);
    index.remove_file(path);
    query_all(&index, path, 0, &input);
});
