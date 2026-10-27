# rozone

Roxygen docs for R scripts: hover and signature help from roxygen comments in
plain `.R` files, in Positron and VS Code. The user-facing readme for the
extension is in [`editors/code/README.md`](editors/code/README.md).

The design is in [`PLAN.md`](PLAN.md). Interface contracts between components
are in [`docs/contracts.md`](docs/contracts.md).

## Architecture

Two tiers, chosen by workspace trust (PLAN §1, §4):

```
rozone/                          (Rust workspace, edition 2024)
  crates/rozone_core   pure Rust, no I/O: extract (air_r_parser) -> roxygen model
                       -> markdown; index; call context; R arg matching;
                       manifest overlay
  crates/rozone_wasm   wasm-bindgen API over rozone_core
  crates/rozone_lsp    later: native LSP for Zed/Neovim/Helix
  editors/code         TS extension
    src/base/          file discovery, worker_thread + WASM, providers
    src/enhanced/      trust gate, R discovery, sidecar client, Positron injection
    r/sidecar.R        bundled; only ever run in trusted workspaces
```

```
                    extension host (Node)
  ┌──────────────────────────────────────────────────────────────┐
  │ base tier (always)                                           │
  │   findFiles/fs ──text──> worker_thread: rozone_wasm (index)  │
  │   Hover/SignatureHelp providers <──────── answers            │
  │                                    ^ load_manifest(json)     │
  │ enhanced tier (isTrusted && R && roxygen2)                   │
  │   SidecarClient ──JSON lines (stdin/stdout)──> Rscript       │
  │                                        r/sidecar.R (warm)    │
  │   PositronInjector ── evaluateCode(loadNamespace) ──> Ark    │
  └──────────────────────────────────────────────────────────────┘
```

- **Base tier** (`rozone_core` through `rozone_wasm`) is always on and never
  runs R. It is the only tier in untrusted workspaces.
- **Enhanced tier** (`editors/code/r/sidecar.R`) is a warm R process that builds
  roxygen2 output and a manifest for the Rust core. It runs only in trusted
  workspaces, and in Positron it also injects a `rozone.docs` package into the
  user's session.

`rozone_lsp` is planned, not implemented.

## Repository layout

| Path | Contents |
|---|---|
| `crates/rozone_core` | Parser-based extraction, roxygen model, markdown, index, call context, manifest overlay. Snapshot tests in `tests/`. |
| `crates/rozone_wasm` | `wasm-bindgen` wrapper, built into `editors/code/wasm/`. |
| `editors/code` | VS Code and Positron extension (TypeScript), sidecar R code, tests, packaging. |
| `editors/code/r` | `sidecar.R`, plus its testthat suite (`tests/testthat`) and hostile fixtures. |
| `fuzz` | cargo-fuzz targets (separate Cargo workspace). See `docs/fuzzing.md`. |
| `docs` | `contracts.md` (interface contracts), `fuzzing.md` (fuzzing notes). |

## Prerequisites

- **Rust** with edition 2024 support, plus the `wasm32-unknown-unknown` target:
  `rustup target add wasm32-unknown-unknown`
- **wasm-pack** (`cargo install wasm-pack --locked`, or a release binary).
- **binaryen** for `wasm-opt`. Optional for dev builds; release builds warn and
  skip size optimisation without it.
- **Node 26** and npm.
- **R** with these packages: `roxygen2`, `jsonlite`, `testthat`, `processx`,
  `withr`. Plus `purrr` and `dplyr` for the sidecar tests.
- For integration tests on Linux: `xvfb-run`.

The Air parser is a pinned git dependency (see `Cargo.toml`). Cargo fetches it
on the first build.

## Build

```sh
node editors/code/scripts/build-wasm.ts          # wasm-pack + wasm-opt into editors/code/wasm/
npm --prefix editors/code ci                     # first time only
npm --prefix editors/code run build              # esbuild bundle into editors/code/dist/
```

`build-wasm.ts` accepts `--dev` for a faster, unoptimised build.

## Tests

Run from the repository root unless noted.

| Command | What it checks |
|---|---|
| `cargo test --workspace` | Rust unit, snapshot and property tests. |
| `cargo clippy --workspace --all-targets -- -D warnings` | Lints, with warnings as errors. |
| `Rscript editors/code/r/run-tests.R` | Sidecar testthat suite (protocol, build, strip rules, hostile fixtures). |
| `npm --prefix editors/code run typecheck` | TypeScript type check. |
| `npm --prefix editors/code run test:unit` | TypeScript unit tests. The real-sidecar test is skipped if `Rscript` is not found. |
| `npm --prefix editors/code run test:wasm` | Node tests against the built WASM module. Needs the WASM build first. |
| `npm --prefix editors/code run test:integration` | VS Code integration tests, using `@vscode/test-electron`. Downloads VS Code. On Linux without a display, run under `xvfb-run -a`. |
| `npm --prefix editors/code test` | Typecheck, unit, WASM and integration tests together. |

### Benchmarks

Benchmarks print timings and do not fail by default. Set `ROZONE_BENCH_STRICT=1`
to enforce the budgets in PLAN §6 (50k-line parse under 50 ms; warm sidecar
single-file rebuild under 100 ms).

```sh
CARGO_PROFILE_RELEASE_OPT_LEVEL=3 ROZONE_BENCH_STRICT=1 cargo test -p rozone_core --release --test bench -- --ignored --nocapture
ROZONE_BENCH_STRICT=1 npm --prefix editors/code run test:wasm
Rscript editors/code/r/run-tests.R              # the R sidecar bench also logs timings
```

### Fuzzing

Fuzz targets (`index_queries`, `roxygen_block`, `manifest_json`) need a nightly
toolchain and `cargo-fuzz`. Run them with `-s none`. Commands and CI notes are in
[`docs/fuzzing.md`](docs/fuzzing.md).

```sh
cargo +nightly fuzz run -s none --fuzz-dir fuzz index_queries -- -max_total_time=60
```

## Packaging

```sh
npm --prefix editors/code run package
```

This runs `vsce package --no-dependencies`. The `vscode:prepublish` script builds
the production bundle first, so run `build-wasm.ts` beforehand. The output is a
`.vsix` in `editors/code/`. Nothing is published from this repository by these
commands.

## Continuous integration

`.github/workflows/`:

- `ci.yml`: Rust checks, WASM build, sidecar tests, extension tests on Linux,
  macOS and Windows, and a VSIX artifact.
- `air-bump.yml`: weekly. Moves the pinned Air and biome revisions to the latest
  Air `main` and opens a pull request.
- `fuzz.yml`: weekly. Runs each fuzz target for a few minutes and uploads any
  crash artifacts.

## Contributing

- Interface changes start in [`docs/contracts.md`](docs/contracts.md), in the
  same commit as the code.
- Keep the base tier free of I/O and of any R dependency. Those belong in the
  extension or sidecar.

## License

MIT. See [LICENSE](LICENSE).
