//! Panic-freedom of manifest loading: any bytes must yield Ok or ManifestError.
#![no_main]

use libfuzzer_sys::fuzz_target;
use rozone_core::Index;

fuzz_target!(|data: &[u8]| {
    let Ok(json) = std::str::from_utf8(data) else {
        return;
    };
    let mut index = Index::new();
    index.update_file("/fuzz/a.R", "f <- function(x) x\nf(1)\n");
    let _ = index.load_manifest(json);
    let _ = index.hover("/fuzz/a.R", 0);
    let _ = index.signature_help("/fuzz/a.R", 20);
    let _ = index.documented_functions();
    index.clear_manifest();
});
