# rozone: roxygen docstrings for R scripts

Goal: roxygen comments above functions in plain `.R` scripts give Positron users
**hover docs** and **signature help / argument hints**, like Python docstrings,
in every file with no setup.

Revision 5 (2026-10-24). Versions checked:
- Positron 2026.09.0 with Ark 0.1.252.
- Air main `a2b36be` (Aether parser).
- Jarl main.
- R 4.6.1, roxygen2 8.1.0.
- Node 26.7.

---

## 1. TL;DR

- **Two tiers, chosen by VS Code workspace trust:**
  - **Base tier (always on; the only tier in untrusted workspaces):** a pure
    Rust core on Air's parser, compiled to WASM, running in the extension host.
    - Hover and signature help for every documented script function.
    - **No R is ever executed.**
  - **Enhanced tier (trusted workspaces only, opt-out, needs R and roxygen2):**
    a long-lived **R sidecar process** builds roxygen2 output.
    - It feeds a manifest back into the Rust core: roxygen2-exact text and
      cross-package `@inheritParams`.
    - In Positron, it also loads a generated `rozone.docs` package into the
      user's session. That gives `?fn`, the Help pane, Ark's completion docs and
      Ark's argument docs.
- The base tier is the foundation and the fallback. If R or roxygen2 is
  missing, the sidecar crashes, or trust isn't granted, users still get hover
  and signature help.
- **R code inside roxygen** (inline `` `r ...` ``, ```` ```{r} ````, `@eval`,
  `@evalRd`, `@evalNamespace`, `@includeRmd`) is **stripped in both tiers**.
  Trust lets *our* R code run, not the docs' code (§3.4).

---

## 2. Measurements behind the design

| Path | Latency | Memory |
|---|---|---|
| WASM core: instantiate | 2.6 ms | — |
| WASM core: 1.34 MB / 50k-line file, 4,000 documented functions | 32 ms | about 20 MB of WASM memory (the spike never frees memory) |
| Cold one-shot `Rscript` + roxygen2 + install + load | about 530 ms | about 122 MB peak |
| **Warm sidecar**, roxygen2 → topics/manifest only | **27 ms** | about 121 MB resident while alive |
| Warm sidecar, + `R CMD INSTALL` + `loadNamespace` (Positron help injection) | 231 ms | same |

The sidecar is worth keeping alive while the user is editing, with an idle
timeout to give the memory back.

---

## 3. Trust tiers

### 3.1 What each tier gives

| Feature | Base (untrusted, or no R) | Enhanced: VS Code | Enhanced: Positron |
|---|---|---|---|
| Hover: call sites, definitions, bare identifiers | Yes | Yes | Yes |
| Signature help: description, per-argument docs, active argument | Yes | Yes | Yes |
| Workspace-local `@inheritParams` / `@inherit` / `@describeIn` | Yes | Yes | Yes |
| Cross-package `@inheritParams dplyr::mutate`, `@inheritDotParams`, `@inheritSection` | Pointer only | **Resolved** (manifest) | **Resolved** |
| Text fidelity | rozone's roxygen subset | **roxygen2-exact** for saved files | **roxygen2-exact** |
| `?fn`, F1, Help pane | Markdown preview command | Markdown preview command | **Yes** (injection) |
| Docs in Ark's completion list | No | n/a | **Yes** |
| Argument docs when Ark's signature popup wins (already-run functions) | No | n/a | **Yes** |
| Runs any R | **Never** | Our sidecar only | Our sidecar plus one `loadNamespace` call in the user's session |

### 3.2 Trust mechanics (VS Code API)

- `package.json` declares:
  ```json
  "capabilities": {
    "untrustedWorkspaces": {
      "supported": "limited",
      "description": "In untrusted workspaces rozone only parses files; it never runs R.",
      "restrictedConfigurations": ["rozone.r.path", "rozone.enhanced.enabled"]
    }
  }
  ```
  `restrictedConfigurations` stops an untrusted repo's `.vscode/settings.json`
  from pointing `rozone.r.path` at a malicious binary or forcing the enhanced
  tier on. The workspace values are ignored until it's trusted.
- At activation the base tier always starts. The enhanced tier starts only if
  **all** of these hold:
  - `vscode.workspace.isTrusted`;
  - `rozone.enhanced.enabled` is true (the default);
  - R is found;
  - `roxygen2` is installed (probed by the sidecar's handshake).
- `workspace.onDidGrantWorkspaceTrust` starts the enhanced tier without a
  reload.
- When trust is removed, VS Code restarts the extension host. We come back in
  base tier and the sidecar is killed in `deactivate()`. Phase 0 verifies this.

### 3.3 R discovery (trusted only)

1. In Positron, the foreground session's `runtimeMetadata.runtimePath` gives
   `Rscript` next to it. This is the same R the user runs.
2. Otherwise, the `rozone.r.path` setting.
3. Otherwise, `Rscript` on `PATH`.

**Library paths:**
- In Positron, read the session's `.libPaths()` once with `evaluateCode`. This
  is our R in the user's session, so trusted only. Pass the result to the
  sidecar as `R_LIBS`.
- Start the sidecar with `--no-init-file` so a project `.Rprofile` doesn't run
  in it. This also covers renv projects, because we take the library paths from
  the live session.
- In VS Code, run without `--no-init-file`, so renv's `.Rprofile` activates its
  library. The workspace is trusted, so this is acceptable.

### 3.4 Inline R in roxygen

- **Stripped in both tiers.** It's the known limitation agreed in rev 3.
- Trust gates *rozone's* R, not code embedded in documentation.
  - Rendering `` `r Sys.time()` `` or an `@eval` would mean executing
    workspace code on every save.
  - That's a bigger step than running our own fixed script.
- **Open decision, deferred:** a separate opt-in
  `rozone.roxygen.evaluateInlineR` setting (default `false`, trusted only,
  itself a restricted configuration) could pass these through to roxygen2.
  Not planned for v1.

---

## 4. Architecture

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

### 4.1 Base tier

This is unchanged from rev 4.
- `rozone_core` grows from `spike/air_roxygen/src/lib.rs`:
  - leading-trivia `#'` extraction on `air_r_parser`;
  - a roxygen subset and the strip rules;
  - markdown rendering;
  - the index;
  - R argument matching (no `oak_*` dependencies).
- `rozone_wasm` exposes it with `wasm-bindgen`, built with `wasm-pack` and
  `wasm-opt -Oz`.
- The TS side discovers and reads files and pushes text into a
  `worker_thread`.
- Hover and signature-help providers return nothing for unknown callees, so
  Ark handles those.
- Signature help is re-registered on Positron session events so it sorts ahead
  of Ark.
- Air is a pinned git dependency with a scheduled bump job (the Jarl #762
  pattern).

### 4.2 Manifest overlay (the Rust side of the enhanced tier)

- `load_manifest(json)`: a per-file map
  `{ path, content_hash, topics: [{ name, title, description_md, params: {name: md}, returns_md, inherited_from: [...] }] }`.
- When resolving a function, use the manifest entry **only if its
  `content_hash` matches the indexed text**. That means saved and unchanged
  files. Otherwise fall back to the static model, so unsaved edits always show
  the live static version.
- Markdown comes from roxygen2's parsed tags, not from Rd.
  - Inherited params are resolved through roxygen2 and rdtools.
  - Render them through the same markdown path so the two tiers look the same.

### 4.3 Sidecar (`r/sidecar.R`)

- **Process:**
  `Rscript [--no-init-file] <ext>/r/sidecar.R`, with `R_LIBS` set as in §3.3.
- **Protocol:** JSON lines over stdin and stdout, using `jsonlite`. Logs go to
  stderr and the output channel.
- **Handshake:** reports the R version, `roxygen2`/`jsonlite` availability and
  versions. If something required is missing, the enhanced tier is disabled
  with one notification: "Install roxygen2 for richer docs".
- **Requests:**
  - `build { files: [{path, text_hash}], install: bool }`
    → `{ manifest, lib_dir? }`.
  - Topics are cached per file by hash, so only changed files go through
    roxygen2 (about 27 ms warm for a typical script).
  - `install: true` only in Positron with injection on. It runs
    `R CMD INSTALL` into `globalStorage/lib-<gen>`, a fresh directory per build
    (the lazy-load cache bug), and deletes old generations.
  - `shutdown`.
- **Build logic** (from the verified `spike/ark_help_injection.R`):
  - `strip_r_code()` (verified against a hostile fixture);
  - evaluate only the `function(...)` literals in a sandbox env, so no bodies or
    defaults run;
  - add `#' @md`;
  - `roxygen2::parse_file` → `roclet_process(rd_roclet())` for Rd, plus the
    block tags for the manifest.
- **Lifecycle:**
  - Lazy start on the first trusted build.
  - Debounced builds on save (300 ms).
  - Idle shutdown after `rozone.sidecar.idleTimeoutMinutes` (default 10).
    Restarted on the next save.
  - Restart with backoff on a crash. After 3 crashes in 5 minutes, stay in base
    tier until reload.
  - Killed in `deactivate()`.
- **Status bar:**
  - "rozone: base" (with a tooltip: untrusted, no R, or roxygen2 missing);
  - "rozone: enhanced";
  - "rozone: enhanced + help" (Positron injection active).

### 4.4 Positron help injection (enhanced, Positron only, `rozone.helpInjection` default `true`)

- After a build with `install: true`, run
  `evaluateCode('r', '<unload old; loadNamespace("rozone.docs", lib.loc = ...)>', token, sessionId, RuntimeBusyBehavior.Reject)`.
  - Retry on the next idle state.
  - Never start a session.
  - Re-inject on session start or restart and on foreground session change.
- **Effects** (verified mechanics from rev 1): `?fn`, F1, the Help pane, Ark's
  completion docs and Ark's per-argument signature docs. Our topic wins
  `utils::help()` name collisions.
- **Footprint:** one extra loaded namespace with no exports, visible in
  `loadedNamespaces()` and `sessionInfo()`.
- **Hover dedupe:**
  - When injection is active, Ark also hovers call sites of script functions.
  - Our provider skips call sites for functions present in the injected build.
    It still hovers definitions and bare identifiers, where Ark never does.

---

## 5. Phased plan

### Phase 0: verify in Positron (½–1 day)

- [ ] A throwaway extension's signature help beats Ark's after re-registering
  on session ready and after a restart.
- [ ] A WASM module in a `worker_thread` loads in Positron's extension host.
- [ ] Trust: `onDidGrantWorkspaceTrust` fires without a reload. Removing trust
  restarts the extension host. `restrictedConfigurations` ignores workspace
  values while untrusted.
- [ ] Injection in a live session: run
  `source("spike/ark_help_injection.R"); rozone_spike_load("spike/example_script.R")`.
  - Hover on a function that hasn't been run shows its docs.
  - The completion docs show.
  - `?wmean` renders.
  - Ark's signature popup shows the argument docs.
- [ ] `evaluateCode` with `RuntimeBusyBehavior.Reject` during `Sys.sleep(10)`
  rejects rather than queueing.

### Phase 1: `rozone_core` (3–4 days)

Grow the spike into extract, roxygen, strip, markdown, index, call and matching,
plus the manifest overlay, with `insta` snapshots.

### Phase 2: base-tier extension MVP (2–3 days)

`rozone_wasm`, the worker, file discovery and watching, the providers and the
ordering logic, and the "Open documentation" preview.

**Done when:** in an **untrusted** Positron window with no R, hover and `fn(`
show the docs and the active argument in under 50 ms, and **no process is
spawned**. Check this with the output channel and the process list.

### Phase 3: enhanced tier (3–4 days)

- The trust gate, R discovery, `r/sidecar.R`, the sidecar client and lifecycle,
  the manifest overlay wiring, the Positron injector and the status bar.

**Done when:**
- in a trusted window, `@inheritParams dplyr::mutate` resolves in hover;
- in Positron, `?wmean`, completion docs and Ark's signature docs work;
- a saved `#'` edit shows within about 0.5 s;
- the sidecar exits after its idle timeout.

### Phase 4: release (1–2 days)

- One universal VSIX to Open VSX and the VS Code Marketplace.
- README covering the tiers, trust and the limitations.
- The Air-bump CI job.

### Phase 5: optional

- `rozone_lsp` for Zed/Neovim/Helix (base tier only).
- An upstream Ark/Oak issue proposing a roxygen fallback for hover and
  signature help.
- The `evaluateInlineR` opt-in (§3.4).

---

## 6. Tests

- **`rozone_core`:**
  - `insta` fixtures: multi-name `@param`, inheritance, `@describeIn`, partial
    matching, `...`, a broken statement mid-file, the strip rules, UTF-16
    offsets;
  - the manifest overlay: hash match uses the manifest, a mismatch falls back
    to static.
- **Sidecar** (testthat, run in CI):
  - the handshake and the protocol;
  - the hostile fixture: no sentinel files from inline `r`, fences, `@eval*`,
    `@includeRmd` or the script body;
  - per-file cache hits;
  - fresh-library rebuilds;
  - collision ordering.
- **Extension** (`@vscode/test-electron`):
  - in an untrusted workspace, assert that `child_process.spawn` is never
    called (stub it) and the base features work;
  - in a trusted workspace, the sidecar starts, builds, idles out, and restarts
    after a crash.
- **Benchmarks:** WASM parsing of 50k lines in under 50 ms; a warm sidecar
  rebuild of one file in under 100 ms without install.

---

## 7. Known limitations

1. **R code inside roxygen is stripped in both tiers:** inline `` `r ...` ``
   (text removed in place), ```` ```{r} ````, `@eval`, `@evalRd`,
   `@evalNamespace`, `@includeRmd`.
2. **Base tier only** (untrusted, or no R/roxygen2):
   - no `?fn` or Help pane;
   - no Ark completion docs;
   - no cross-package inheritance (a pointer is shown);
   - roxygen-subset rendering;
   - already-run functions depend on signature-help ordering.
3. **Enhanced tier:**
   - about 121 MB for the sidecar while active (idle timeout);
   - needs `roxygen2` and `jsonlite`;
   - Positron injection adds a visible `rozone.docs` namespace;
   - script docs don't appear in Help-pane *search* (Ark #1401 indexes
     `.libPaths()` only).
4. Only **top-level `name <- function(...)`** definitions. Not covered:
   `purrr::partial()`, `memoise()`, `local()`, R6/S7/S4 methods.
5. Name collisions follow R masking: a documented script `filter` takes over
   hover for `filter(` calls.
6. **Air is a git dependency** with no API stability guarantee. It's pinned,
   with a bump job.

---

## 8. Verification status

**Verified:**
- `air_r_parser` extraction and call context, native and as WASM in Node (size,
  instantiation time, throughput).
- The Rd-injection mechanics (rev 1).
- `strip_r_code()` against a hostile fixture.
- Sidecar costs: cold about 530 ms / 122 MB; warm 27 ms without install and
  231 ms with it; 121 MB resident.
- Jarl #762's dependency pattern.
- The Positron API surface.

**Not verified:**
- Phase 0 items.
- Trust revocation behaviour.
- `->` assignment shape.
- Size after `wasm-opt`.

Spikes:
- `spike/air_roxygen/`: the Rust core, WASM build, and Node runner
  `run_wasm.mjs`.
- `spike/ark_help_injection.R`: the sidecar build logic and the injection
  reference.
