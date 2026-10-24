//! Structure-aware: generated roxygen blocks + function definitions + calls,
//! queried at a bounded sweep of offsets so deep parser/doc paths are reached.
#![no_main]

use libfuzzer_sys::fuzz_target;
use rozone_core::Index;
use rozone_fuzz::Script;

fuzz_target!(|script: Script| {
    let text = script.render();
    let mut index = Index::new();
    index.update_file("/fuzz/a.R", &text);

    let len = text.encode_utf16().count() as u32;
    let step = (len / 512).max(1);
    for offset in (0..=len + 1).step_by(step as usize) {
        let _ = index.hover("/fuzz/a.R", offset);
        let _ = index.signature_help("/fuzz/a.R", offset);
    }
    for f in index.documented_functions() {
        let _ = index.documentation(&f.name, Some("/fuzz/a.R"));
        let _ = index.hover("/fuzz/a.R", f.range.start);
    }
});
