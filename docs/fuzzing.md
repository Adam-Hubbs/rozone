# Fuzzing and generative testing for rozone

Post-MVP research note. Nothing here is on the critical path. The prototype lives in `fuzz/`.

## 1. What Posit actually does

### The recollection needs a correction

The fuzzing is in **Ark's repo, but it is for Oak** (the new semantic-analysis engine that lives as `crates/oak_*` inside `posit-dev/ark`), not for Ark's kernel and not for Air. `posit-dev/oak` does not exist as a separate repo (`gh repo view posit-dev/oak` fails). Code search for "fuzz" in `posit-dev/air` returns nothing, and there is no fuzz-related issue there. I did not find any fuzzing in `r-lib/tree-sitter-r`. Code search has gaps (default branch only, indexing lag), so "not found" is not proof of absence.

### What exists: structured, coverage-guided fuzzing of Oak's Salsa queries

- Tracking issue: [posit-dev/ark#1409 "Harden cycle recovery in Oak analysis"](https://github.com/posit-dev/ark/issues/1409). The motivation was an LSP crash from a Salsa query cycle ([positron#15631](https://github.com/posit-dev/positron/issues/15631), fixed by [ark#1393](https://github.com/posit-dev/ark/pull/1393)).
- Main PR: [posit-dev/ark#1418 "Add fuzz-testing for Oak's analysis engine"](https://github.com/posit-dev/ark/pull/1418), by Lionel Henry, merged 2026-10-17 as `8dcc0d76a78647d858b64c044855c24ab45e4e5c`. Preparatory PRs: [#1413](https://github.com/posit-dev/ark/pull/1413) (make cycle recovery observable in tests) and [#1414](https://github.com/posit-dev/ark/pull/1414) (abstract file reads for tests).
- Layout:
  - `crates/oak_db/fuzz/` is a nested cargo-fuzz workspace. Its [README](https://github.com/posit-dev/ark/blob/main/crates/oak_db/fuzz/README.md) is the best single reference.
  - `crates/oak_db/fuzz/fuzz_targets/scenario.rs` is a thin libFuzzer shell. It uses `libfuzzer-sys` with a custom `fuzz_mutator!`, and delegates to `oak_db::fuzz::{execute_json, mutate_json, Runner}`.
  - `crates/oak_db/src/fuzz/` holds the scenario model, generator, mutator, runner, oracle, corpus seeds and so on, behind a `fuzz` feature.
  - `crates/oak_semantic/src/fuzz.rs` and `crates/oak_semantic/src/effects/fuzz.rs` hold the R program model and renderer.
  - CI: `.github/workflows/test-fuzz.yml`.
- How inputs are generated: not raw bytes and not CRAN. The input is a serde-serialized **Scenario**: a generated mini-workspace (packages, `R/` collation, testthat/Shiny layouts), an initial cold query, and a history of queries and edits. R programs come from a typed program model (`Program`/`Stmt`/`Expr` plus "effects" such as Attach, Source, Assign, Quote) rendered to real R text. Seeds are motifs: chains, self-loops, rings, overlapping cycles. A structure-aware mutator adds `source()` calls, renames or shadows identifiers, edits package exports, and adds or removes files. Named Rust fixtures are the regression seeds. Libfuzzer corpus under `crates/oak_db/fuzz/corpus/scenario/` is gitignored.
- What it checks (from the PR body): panics; **incremental vs fresh-database consistency** of symbol resolution (a differential/metamorphic oracle for Salsa); and timeouts (20 s per scenario). It deliberately does not assert expected semantic values.
- How it runs:
  - Fixed-seed "mutation blocks" (`just fuzz`) run as ignored nextest tests on PRs and pushes to main.
  - Coverage-guided exploration (`just fuzz-explore`) runs 5 minutes on pushes to main, and 30 minutes on a Monday/Thursday cron.
  - The corpus is persisted in the GitHub Actions cache and minimized with `cmin`. PRs replay it read-only.
  - Failure artifacts are uploaded.
  - It runs with `-s none` (no ASan) for throughput.
- Not found: `cargo-fuzz`/AFL/proptest for the R parser itself, differential testing against R's `parse()`, formatter idempotency fuzzing, or CRAN-sourced corpora. I searched for `proptest` in `posit-dev/ark` and `posit-dev/air` Cargo files and found nothing. Air has a few hand-written idempotency unit tests (e.g. `crates/air_r_parser/src/lexer/tests/brackets.rs`, `crates/air_r_parser_tests/src/document.rs`), which are ordinary tests rather than fuzzing. I did not exhaustively audit Air's formatter test suite.

Takeaway: the closest-to-useful ideas for rozone are the architecture (thin libFuzzer shell, logic and byte-decoding in a normal crate so it is testable, fixed-seed deterministic runs on PRs, cached-corpus exploration on a schedule) and the idea of an incremental-vs-fresh oracle. rozone's `update_file` replacing prior state is the same shape.

## 2. What transfers to rozone

| Idea | Value | Effort | Notes |
|---|---|---|---|
| (a) Panic-freedom of `update_file` + `hover`/`signature_help`/`documentation` at arbitrary offsets | High | Done (prototype) | Targets `index_queries`, `manifest_json`. UTF-16 offsets past the end, mid-surrogate and mid-CRLF are the likely bugs. Add a metamorphic check once the core exists: `update_file(A); update_file(B)` must equal a fresh `Index` with only B. This is the Oak "incremental vs fresh" idea. |
| (b) Grammar-aware R + roxygen generation | Medium-high | Done (prototype, `fuzz/src/lib.rs`) | Reaches roxygen parsing paths that byte-level fuzzing would take long to find. Extend with Oak-style round-tripping: the generator knows the expected params/title, so `hover` output can be asserted, not only "no panic". |
| (f) CRAN smoke run | Medium | Low | `fuzz/cran_corpus.sh` fetches sources. Loop over `R/*.R`, `update_file` + query at every identifier; assert no panic and a per-file time budget (Oak uses a 20 s hang limit). This is also the best realism check for roxygen edge cases. Do it as an `ignored` cargo test or example, not in libFuzzer. |
| (d) Rust strip rules vs R `strip_r_code()` | Medium | Medium | Needs R on the runner. Generate inputs, run both implementations (R via `Rscript` with a JSON round-trip), and compare. Best as a seeded proptest or a script run on a schedule, since process spawning is too slow for libFuzzer. |
| (c) Static docs vs sidecar roxygen2 manifest | Medium | Medium-high | roxygen2 is the oracle for `@param` and title. Expect many legitimate differences (inheritance, markdown rendering, `@describeIn`), so compare only a normalized subset (param names, title text). Needs roxygen2 installed in CI. |
| (e) Sidecar security fuzzing | High for risk, low volume | Medium | Cheap, high-signal version: a fixed set of adversarial scripts (roxygen with `@eval`, `@evalRd`, `@examples` side effects, `Rd` macros, top-level `system()`/`file.create()`), each containing a unique sentinel path. Run the sidecar against each in a temp dir and assert no sentinel appears. Randomizing on top of it via the Section 3 generator is straightforward. Run this before any release. Note that roxygen2's `@eval` is by design arbitrary code execution, so the sidecar must be shown to refuse or strip it, which is exactly what this verifies. |

### Ranking (value over effort, post-MVP)

1. (a) panic-freedom plus fresh-vs-incremental oracle. Prototype exists, and the scheduled CI job is cheap.
2. (e) sentinel-file security tests, as a deterministic corpus first.
3. (f) CRAN smoke run as an ignored test with timing.
4. (b) richer generator with oracle assertions on hover contents.
5. (d) strip-rule differential testing.
6. (c) roxygen2 manifest differential testing (highest flakiness and setup cost).

Not worth doing: AFL, differential testing of Air's parser against `parse()`. The parser is upstream and pinned, so bugs there are Air's. rozone should only guard its own handling of parser output (including error-recovery trees).

## 3. The prototype (`fuzz/`)

Its own `[workspace]`, so root `cargo test` is unaffected. `fuzz/target`, `fuzz/corpus`, `fuzz/artifacts` are already in `.gitignore`.

- `fuzz/fuzz_targets/index_queries.rs`: `arbitrary`-derived text, optional second text (edit), raw u32 offsets plus offsets modded into range, names for `documentation`, then `remove_file` and re-query.
- `fuzz/fuzz_targets/roxygen_block.rs`: structure-aware. `rozone_fuzz::Script` (`fuzz/src/lib.rs`) renders roxygen tags (including CRLF, unbalanced braces, non-ASCII, unknown tags, backtick names, `...`), function definitions and calls. It sweeps offsets (at most about 512 probes) and then queries every documented function.
- `fuzz/fuzz_targets/manifest_json.rs`: arbitrary bytes to `load_manifest`.
- `fuzz/cran_corpus.sh`: downloads a few CRAN sources (via crandb for the version, then cloud.r-project.org) into `fuzz/corpus/cran/<pkg>/` and seeds `fuzz/corpus/index_queries/`.

Run (from the worktree root; macOS arm64 verified, nightly installed, `cargo-fuzz` 0.13.2):

```sh
rustup toolchain install nightly
cargo install cargo-fuzz --locked
cargo +nightly fuzz build -s none --fuzz-dir fuzz
cargo +nightly fuzz run -s none --fuzz-dir fuzz index_queries -- -max_total_time=60
cargo +nightly fuzz run -s none --fuzz-dir fuzz roxygen_block -- -max_total_time=60
fuzz/cran_corpus.sh            # optional seeds
```

`-s none` follows Oak's choice (they measured ASan as much slower). Rozone is safe Rust, so ASan adds little. The libFuzzer `__sanitizer_*` dlsym warnings in the output are harmless.

Status: all three targets compile. While `Index` methods were `todo!()`, `index_queries` panicked on the first input (`not yet implemented`), which is expected. Re-run once the core lands. Failures reproduce with `cargo +nightly fuzz run -s none --fuzz-dir fuzz <target> <artifact>`, and `tmin` shrinks them. Promote each minimized artifact to a named regression test in `rozone_core`, as Oak does.

## 4. CI integration sketch

Mirror Oak's split (see its `test-fuzz.yml`):

1. **PR job (blocking, around 2 minutes)**: `cargo +nightly fuzz run -s none --fuzz-dir fuzz <target> -- -runs=20000 -seed=1` per target against the committed regression corpus, plus the CRAN smoke test if sources are cached. Fixed seed means reproducible. Alternatively, wrap the same logic as plain `#[test]`s with `arbitrary` fed from a seeded RNG so no nightly toolchain is needed on PRs.
2. **Scheduled job (non-blocking)**: cron two times a week, 20-30 minutes per target, restore and save `fuzz/corpus` with `actions/cache` (restore-keys prefix, refresh within 7 days to avoid cache expiry), `cmin` before saving, upload `fuzz/artifacts` on failure.
3. **Release gate**: the sentinel-file sidecar test (e), and optionally the strip-rule differential (d), on a runner with R and roxygen2.

Install `cargo-fuzz` via `taiki-e/install-action` and use `Swatinem/rust-cache` with `workspaces: fuzz`.
