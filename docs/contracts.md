# rozone interface contracts

These are the fixed seams between the four components. Change them only by
editing this file first, in the same commit as the code.

```
crates/rozone_core   Rust, no I/O           (§1)
crates/rozone_wasm   wasm-bindgen wrapper   (§2)  -> editors/code/wasm/ (wasm-pack --target nodejs)
editors/code         TS extension           (§2 consumer, §4 client)
editors/code/r       sidecar.R              (§3 producer, §4 server)
```

## 0. Shared conventions

- **Offsets** crossing any boundary are **UTF-16 code units** from the start of
  the text (what `vscode.TextDocument.offsetAt()` returns). Ranges are
  half-open `{ start, end }`.
- **Paths** are opaque strings chosen by the TS side (absolute `fsPath`). The
  core never touches the filesystem.
- **Content hash**: FNV-1a 64-bit over the UTF-8 bytes of the text, rendered as
  16 lowercase hex digits. Offset basis `0xcbf29ce484222325`, prime
  `0x100000001b3`. `content_hash("")` is `"cbf29ce484222325"`. The TS side gets
  it from `contentHash()` in the WASM module; the sidecar only echoes it.

## 1. `rozone_core` public API (Rust)

```rust
pub struct Index { /* ... */ }

impl Index {
    pub fn new() -> Self;
    pub fn update_file(&mut self, path: &str, text: &str);
    pub fn remove_file(&mut self, path: &str);
    pub fn load_manifest(&mut self, json: &str) -> Result<(), ManifestError>; // replaces any previous manifest
    pub fn clear_manifest(&mut self);
    pub fn hover(&self, path: &str, offset: u32) -> Option<Hover>;
    pub fn signature_help(&self, path: &str, offset: u32) -> Option<SignatureHelp>;
    /// Full documentation page (markdown) for the "Open documentation" preview.
    pub fn documentation(&self, name: &str, from_path: Option<&str>) -> Option<String>;
    pub fn documented_functions(&self) -> Vec<FunctionSummary>;
}

pub fn content_hash(text: &str) -> String;
```

Output types serialize with `#[serde(rename_all = "camelCase")]`:

```ts
type HoverKind = "call" | "definition" | "identifier";
interface Range { start: number; end: number }          // UTF-16
interface Hover {
  name: string;          // resolved function name
  kind: HoverKind;       // call = callee of a call; definition = LHS of the assignment; identifier = any other bare use
  markdown: string;
  range: Range;          // the hovered identifier
  source: "static" | "manifest";
}
interface ParameterInfo { label: [number, number]; documentation: string } // label = UTF-16 offsets into SignatureHelp.label
interface SignatureHelp {
  name: string;
  label: string;         // e.g. "wmean(x, w = rep(1, length(x)))"
  documentation: string; // markdown: title + description
  parameters: ParameterInfo[];
  activeParameter: number | null; // index into parameters after R argument matching; null if unmatched
  source: "static" | "manifest";
}
interface FunctionSummary { name: string; path: string; range: Range; title: string | null }
```

Resolution rules:

- A name resolves to the definition in the **same file** first, otherwise the
  definition in the lexicographically smallest path. Within one file the first
  definition wins. Only top-level `name <- function`, `name = function`,
  `name <<- function`, and the parenthesised right-assignments
  `(function(...) ...) -> name` / `->> name` count. (Unparenthesised
  `function(x) x -> name` parses, as in R, as a function whose body assigns.)
- Unknown callees, `pkg::fn` callees and undocumented functions return `None`
  (Ark handles them). An undocumented function *with* a manifest topic is
  documented.
- **Manifest overlay**: a manifest topic is used only if its file's
  `content_hash` equals the hash of the text currently indexed for that path;
  otherwise the static model is used.

## 2. WASM API (`rozone_wasm`, JS, `wasm-pack build --target nodejs`)

```ts
export class RozoneIndex {
  constructor();
  updateFile(path: string, text: string): void;
  removeFile(path: string): void;
  loadManifest(json: string): void;             // throws Error(message) on invalid JSON / schema
  clearManifest(): void;
  hover(path: string, offset: number): Hover | undefined;
  signatureHelp(path: string, offset: number): SignatureHelp | undefined;
  documentation(name: string, from_path?: string | null): string | undefined; // wasm-bindgen keeps the Rust parameter name
  documentedFunctions(): FunctionSummary[];
  free(): void;
}
export function contentHash(text: string): string;
export function version(): string;
```

Objects are plain JS objects (`serde-wasm-bindgen`'s `json_compatible()`
serializer: `Option::None` is `undefined` at the top level and `null` inside
objects). A Rust panic traps and reaches JS as `WebAssembly.RuntimeError:
unreachable`; the worker treats it as fatal for that index instance and rebuilds
from its last-known texts. The built package is not checked into git; it is
produced into `editors/code/wasm/` by `npm run build:wasm` (which also writes a
`{"type": "commonjs"}` `package.json` there, because the extension is
`"type": "module"` and wasm-pack's nodejs output is CommonJS) and copied into
`dist/wasm/` by the esbuild step.

## 3. Manifest JSON (sidecar -> core)

```json
{
  "version": 1,
  "files": [
    {
      "path": "/abs/script.R",
      "content_hash": "0123456789abcdef",
      "topics": [
        {
          "name": "wmean",
          "aliases": ["wmean"],
          "title": "Weighted mean of a column",
          "description_md": "Computes a weighted mean, dropping `NA` pairs.",
          "details_md": null,
          "params": [{ "name": "x", "md": "A numeric vector." }, { "name": "w", "md": "Weights, the same length as `x`." }],
          "returns_md": "A length-1 double.",
          "sections": [{ "title": "Notes", "md": "..." }],
          "examples": "wmean(1:3, c(1, 1, 2))",
          "inherited_from": ["dplyr::mutate"]
        }
      ]
    }
  ]
}
```

- Markdown fields hold **roxygen-flavoured markdown source** (links like
  `[wmean()]` and `[dplyr::mutate()]` left as-is); the core renders them through
  the same markdown path as static docs so both tiers look identical.
  Parameters inherited from other packages arrive already converted from Rd to
  markdown by the sidecar.
- Multi-name params (`@param x,y`) are split into one entry per name, sharing
  `md`. Params are in the function's formal order where known.
- Unknown fields are ignored; missing optional fields are `null`/absent.
  `version` other than `1` is a `ManifestError`.

## 4. Sidecar protocol (TS <-> `r/sidecar.R`, JSON lines)

Process: `Rscript [--no-init-file] <ext>/r/sidecar.R`, with `R_LIBS` set by the
client. One JSON object per line on stdin and stdout; logs on stderr only.

**Hello** (written once at startup, before any request, without needing
jsonlite; if a required package is missing, write it and exit with status 3):

```json
{"event":"hello","protocol":1,"r_version":"4.6.1","packages":{"roxygen2":"8.1.0","jsonlite":"2.0.0"},"missing":[],"ok":true}
```

**Requests** `{"id": <int>, "method": <string>, "params": {...}}`, answered by
exactly one `{"id": <same>, "result": {...}}` or
`{"id": <same>, "error": {"message": "..."}}`. Requests are processed in order.

- `build`
  - params: `{ "files": [{ "path": "...", "hash": "...", "text": "..."? }], "install": false, "lib_root": "/globalStorage/path"? }`
    - `text` is optional; if absent the file is read from disk.
    - The request lists the **complete** set of workspace files; files not
      listed are dropped from the cache.
  - result: `{ "manifest": <§3>, "lib_dir": "/.../lib-<gen>" | null, "topics": ["wmean", ...], "cache_hits": <int>, "errors": [{ "path": "...", "message": "..." }] }`
    - A file roxygen2 can't parse goes in `errors` and is omitted from the
      manifest; the rest of the build still succeeds.
    - `install: true` requires `lib_root`; it runs `R CMD INSTALL` of a
      generated `rozone.docs` package into a fresh `lib_root/lib-<gen>` and
      deletes older generations.
    - `topics` is the sorted set of aliases in the generated package after
      collision resolution (smallest path wins), i.e. what the hover provider
      skips for call sites once injected.
    - An `R CMD INSTALL` failure does not fail the build: `lib_dir` is `null`
      and `errors` gets an entry with `path: "rozone.docs"`. An unchanged
      `(path, hash)` set and `lib_root` reuses the previous `lib_dir`.
    - Cross-package inheritance from an uninstalled package adds an `errors`
      entry for that file; the file stays in the manifest.
    - Generated Rd whose macro-expanded tree contains `\Sexpr` is dropped
      from the installed package (noted in `errors`).
- `ping` -> `{ "pong": true }`
- `shutdown` -> `{ "ok": true }`, then the process exits with status 0.
  EOF on stdin also exits 0.

Framing details: blank input lines get no response; a line that isn't a JSON
object gets an error with `"id": null` and the loop continues. Clients must
skip non-JSON stdout lines before hello (a user `.Rprofile` can print when
`--no-init-file` isn't used). Test hook: `ROZONE_SIDECAR_REQUIRE=a,b`
overrides the required-package list.

Security: the sidecar never evaluates script bodies, default arguments, inline
`` `r ...` `` (or `` `Rd ...` ``) code, ```` ```{r} ````/`~~~{r}` chunks,
`@eval`, `@evalRd`, `@evalNamespace`, `@includeRmd`, `@template`/`@templateVar`
(brew) or `@example` files; roxygen2's evaluating internals are replaced with
fail-closed guards, and the sandbox env's parent is `baseenv()`.

## 5. Positron injection (TS -> user's R session)

```r
local({
  if (isNamespaceLoaded("rozone.docs")) unloadNamespace("rozone.docs")
  loadNamespace("rozone.docs", lib.loc = "<lib_dir>")
  invisible()
})
```

run with `positron.runtime.executeCode`/`evaluateCode` and
`RuntimeBusyBehavior.Reject`; topics in the build are the set the hover
provider skips for `kind == "call"`.
