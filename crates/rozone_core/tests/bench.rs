//! Timing check for a large script. Run with:
//! `CARGO_PROFILE_RELEASE_OPT_LEVEL=3 ROZONE_BENCH_STRICT=1 cargo test -p rozone_core --release --test bench -- --ignored --nocapture`

use std::time::Instant;

use rozone_core::Index;

fn generate(functions: usize) -> String {
    let mut text = String::new();
    for i in 0..functions {
        text.push_str(&format!(
            "#' Title of function {i}\n#'\n#' Description of function {i}, long enough to take some space.\n#'\n\
             #' @param x The x for {i}.\n#' @param w Weights for {i}.\n#' @returns A number.\n\
             fn_{i} <- function(x, w = rep(1, length(x))) {{\n  keep <- !is.na(x) & !is.na(w)\n  sum(x[keep] * w[keep]) / sum(w[keep])\n}}\n\n\
             fn_{i}(c(1, 2), w = 3)\n"
        ));
    }
    text
}

#[test]
#[ignore = "timing benchmark; run in release mode"]
fn large_file() {
    let text = generate(4000);
    println!("{} lines, {} bytes", text.lines().count(), text.len());
    let mut index = Index::new();

    let start = Instant::now();
    index.update_file("/big.R", &text);
    let update = start.elapsed();
    println!("update_file: {update:?}");

    let offset = text.find("fn_2000(c(1").unwrap() as u32;
    let start = Instant::now();
    let runs = 1000;
    for i in 0..runs {
        let hover = index.hover("/big.R", offset + (i % 3)).unwrap();
        std::hint::black_box(hover);
    }
    println!("hover: {:?} each", start.elapsed() / runs);

    let start = Instant::now();
    for _ in 0..runs {
        let help = index.signature_help("/big.R", offset + 8).unwrap();
        std::hint::black_box(help);
    }
    println!("signature_help: {:?} each", start.elapsed() / runs);

    let start = Instant::now();
    let docs = index.documented_functions();
    println!("documented_functions ({}): {:?}", docs.len(), start.elapsed());
    assert_eq!(docs.len(), 4000);

    // The workspace release profile is size-optimised (opt-level "z"), which
    // roughly doubles parse time; the 50 ms budget assumes a speed-optimised build.
    if std::env::var_os("ROZONE_BENCH_STRICT").is_some() {
        assert!(update.as_millis() < 50, "update_file took {update:?}");
    }
}
