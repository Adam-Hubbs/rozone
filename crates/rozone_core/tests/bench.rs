//! Timing checks for large scripts and workspaces. Run with:
//! `ROZONE_BENCH_STRICT=1 cargo test -p rozone_core --release --test bench -- --ignored --nocapture`

use std::time::{Duration, Instant};

use rozone_core::{Index, content_hash};

fn function_block(name: &str) -> String {
    format!(
        "#' Title of {name}\n#'\n#' Description of {name}, long enough to take some space.\n#'\n\
         #' @param x The x for {name}.\n#' @param w Weights for {name}.\n#' @returns A number.\n\
         #' @examples\n#' {name}(1:3)\n\
         {name} <- function(x, w = rep(1, length(x))) {{\n  keep <- !is.na(x) & !is.na(w)\n  sum(x[keep] * w[keep]) / sum(w[keep])\n}}\n\n"
    )
}

fn generate(functions: usize) -> String {
    let mut text = String::new();
    for i in 0..functions {
        text.push_str(&function_block(&format!("fn_{i}")));
        text.push_str(&format!("fn_{i}(c(1, 2), w = 3)\n"));
    }
    text
}

fn strict() -> bool {
    std::env::var_os("ROZONE_BENCH_STRICT").is_some()
}

/// Mean time per call over `runs` calls.
fn per_call<T>(runs: u32, mut work: impl FnMut(u32) -> T) -> Duration {
    let start = Instant::now();
    for i in 0..runs {
        std::hint::black_box(work(i));
    }
    start.elapsed() / runs
}

fn timed<T>(work: impl FnOnce() -> T) -> (T, Duration) {
    let start = Instant::now();
    let out = work();
    (out, start.elapsed())
}

#[test]
#[ignore = "timing benchmark; run in release mode"]
fn large_file() {
    let text = generate(4000);
    println!("{} lines, {} bytes", text.lines().count(), text.len());
    let mut index = Index::new();

    let ((), update) = timed(|| index.update_file("/big.R", &text));
    println!("update_file: {update:?}");

    let offset = text.find("fn_2000(c(1").unwrap() as u32;
    let hover = per_call(1000, |i| index.hover("/big.R", offset + (i % 3)).unwrap());
    println!("hover: {hover:?} each");

    let help = per_call(1000, |_| {
        index.signature_help("/big.R", offset + 8).unwrap()
    });
    println!("signature_help: {help:?} each");

    let page = per_call(1000, |_| index.documentation("fn_2000", None).unwrap());
    println!("documentation: {page:?} each");

    let (docs, listed) = timed(|| index.documented_functions());
    println!("documented_functions ({}): {listed:?}", docs.len());
    assert_eq!(docs.len(), 4000);

    // The budget assumes the workspace release profile (opt-level 3); a
    // size-optimised build roughly doubles parse time.
    if strict() {
        assert!(update.as_millis() < 25, "update_file took {update:?}");
        assert!(hover.as_micros() < 500, "hover took {hover:?}");
    }
}

/// Editing one file in a big workspace must not cost a whole-workspace rebuild.
#[test]
#[ignore = "timing benchmark; run in release mode"]
fn many_files_and_incremental_edit() {
    let files: Vec<(String, String)> = (0..500)
        .map(|f| {
            let body: String = (0..20)
                .map(|i| function_block(&format!("f{f}_{i}")))
                .collect();
            let call = format!("use_{f} <- f{}_0(1:3)\n", (f + 1) % 500);
            (format!("/ws/file_{f:03}.R"), body + &call)
        })
        .collect();
    let mut index = Index::new();

    let ((), initial) = timed(|| {
        for (path, text) in &files {
            index.update_file(path, text);
        }
    });
    println!("initial index of {} files: {initial:?}", files.len());

    let (path, text) = &files[250];
    let edited = text.replace("Title of f250_3", "Edited title of f250_3");
    let edit = per_call(200, |i| {
        index.update_file(path, if i % 2 == 0 { &edited } else { text })
    });
    println!("re-index one file: {edit:?} each");

    let offset = text.find("f251_0(1:3)").unwrap() as u32;
    let hover = per_call(1000, |_| index.hover(path, offset).unwrap());
    println!("cross-file hover: {hover:?} each");

    let missing = per_call(1000, |_| index.hover(path, 0));
    println!("hover on a non-function: {missing:?} each");

    if strict() {
        assert!(edit.as_millis() < 5, "re-index took {edit:?}");
        assert!(hover.as_micros() < 500, "hover took {hover:?}");
    }
}

#[test]
#[ignore = "timing benchmark; run in release mode"]
fn manifest_overlay() {
    let functions = 4000;
    let text = generate(functions);
    let topics: Vec<String> = (0..functions)
        .map(|i| {
            format!(
                r#"{{"name":"fn_{i}","aliases":["fn_{i}"],"title":"Manifest title {i}","description_md":"From [fn_{i}()].","params":[{{"name":"x","md":"X {i}."}},{{"name":"w","md":"W {i}."}}],"returns_md":"A number.","examples":"fn_{i}(1)"}}"#
            )
        })
        .collect();
    let json = format!(
        r#"{{"version":1,"files":[{{"path":"/big.R","content_hash":"{}","topics":[{}]}}]}}"#,
        content_hash(&text),
        topics.join(",")
    );
    println!("manifest: {} bytes, {functions} topics", json.len());

    let mut index = Index::new();
    index.update_file("/big.R", &text);
    let (loaded, load) = timed(|| index.load_manifest(&json));
    loaded.unwrap();
    println!("load_manifest: {load:?}");

    let (hash, hashing) = timed(|| content_hash(&text));
    println!("content_hash ({} bytes): {hashing:?}", text.len());
    std::hint::black_box(hash);

    let offset = text.find("fn_2000(c(1").unwrap() as u32;
    let hover = per_call(1000, |_| index.hover("/big.R", offset).unwrap());
    assert!(
        index
            .hover("/big.R", offset)
            .unwrap()
            .markdown
            .contains("Manifest title 2000")
    );
    println!("manifest hover: {hover:?} each");

    if strict() {
        assert!(load.as_millis() < 50, "load_manifest took {load:?}");
    }
}
