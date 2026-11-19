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
- **Doc hash**: the same FNV-1a 64 (16 lowercase hex digits) over a canonical
  string of only what can change roxygen2's output for a file, so editing a
  function *body* leaves it unchanged. The string is a sequence of records
  `<tag><byte length>:<body>\n`, in this order:
  1. `R` records: every line matching `^\s*#+'` anywhere in the file, in order,
     verbatim (without the line terminator).
  2. For each top-level statement in document order: if it is a function
     plain function definition (one of the assignment forms in §1's first
     resolution rule; S4, R6 and S7 definitions are not), a `D` record whose body is
     `<raw text of the attached #' block, "" if none>\x1f<name>\x1f<exact source text of the parameter list, parentheses and defaults included>`;
     otherwise, if its leading trivia contains a `#'` line (attached or
     separated by blank lines), an `X` record whose body is
     `<the leading comments and line breaks verbatim>\x1f<the statement's full trimmed source text>`.
  Everything else (bodies, plain code, plain comments) is ignored. When in
  doubt something is included. `Index::fingerprints()` computes it lazily and
  caches it per file; it is requested once per save, not per keystroke.

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
    /// Also accepts the member names hovers report: `Class$member`, `Class$new`, `Class@slot`.
    pub fn documentation(&self, name: &str, from_path: Option<&str>) -> Option<String>;
    pub fn documented_functions(&self) -> Vec<FunctionSummary>;
    /// Every indexed file, sorted by path.
    pub fn fingerprints(&self) -> Vec<FileFingerprint>;
}

pub fn content_hash(text: &str) -> String;
```

Output types serialize with `#[serde(rename_all = "camelCase")]`:

```ts
type HoverKind = "call" | "definition" | "identifier";
interface Range { start: number; end: number }          // UTF-16
interface Hover {
  name: string;          // resolved name; "Class$member" / "Class$new" for R6 and reference class members, "Class@slot" for S4 slots and S7 properties
  kind: HoverKind;       // call = callee of a call (incl. x$m(...)); definition = LHS of the assignment; identifier = any other use
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
interface FileFingerprint { path: string; contentHash: string; docHash: string }
interface FunctionSummary { name: string; path: string; range: Range; title: string | null } // functions, classes and generics
```

Resolution rules:

- A name resolves to the definition in the **same file** first, otherwise the
  definition in the lexicographically smallest path. Within one file the first
  definition wins. Plain functions are the top-level `name <- function`,
  `name = function`, `name <<- function`, and the parenthesised
  right-assignments `(function(...) ...) -> name` / `->> name`. (Unparenthesised
  `function(x) x -> name` parses, as in R, as a function whose body assigns.)
- **Object-oriented definitions** (top level, recognised statically; nothing
  is evaluated). Arguments are bound with R's matching rules, so named and
  positional forms agree; S7's `:=` adds `name = "<lhs>"`, so positional
  arguments shift (`f := new_generic("x")` has `dispatch_args = "x"`).
  `pkg::` prefixes on the constructor are ignored.
  - S4: `setGeneric(name, def)` with a `def` is a generic named by `name`.
    `setClass(Class, ...)` is a class; assigned (`X <- setClass(...)`) it is
    callable as `X(...)`, otherwise its usage is `new("Class", ...)`. Its
    arguments are slots from `representation()` and `slots =`, after those of
    a workspace parent named by `contains` or an unnamed `representation()`
    string; defaults come from `prototype`. `setMethod(f, signature, ...)` is a
    method of `f`.
  - S7: `X <- new_class(...)` / `X := new_class(...)` is a callable class whose
    arguments are its parent's (when the parent is a workspace class) then its
    own properties, defaults from `new_property(default =)`; below a class with
    a custom `constructor` they are `...` and its own properties, and with its
    own `constructor` they are that function's. `new_generic(name,
    dispatch_args, fun)` is a generic taking `fun`'s formals, or
    `dispatch_args` then `...`. `method(generic, signature) <- function` is a
    method; `<- NULL` is not. `X <- new_union(...)` and `X <- class_a |
    class_b` (only when every operand is an identifier or `NULL` and one is
    `class_*` or `NULL`, so `a | b` stays a logical or) are unions: not
    callable, shown with their classes. `X <- new_external_generic(package,
    name, dispatch_args)` stands for `package::name` (with `:=`, `name` is
    `X`); it is not callable, and methods registered with `method(X, ...)`
    are listed on its page. `:=` is not recognised for `setClass`,
    `setRefClass`, `R6Class` or `new_union`, which take no `name`.
  - R6: `X <- R6Class(...)` is a class, called through `X$new()` with the
    formals of the first `initialize` in its `inherit` chain. Members come from
    `public`, `private` and `active` lists, with `#'` blocks on the members.
  - Reference classes: `setRefClass(Class, fields, contains, methods)` is a
    class, callable as `X(...)` and `X$new(...)` when assigned to `X`. Its
    constructor takes the first `initialize` in its `contains` chain, else
    its and its ancestors' fields. Methods come from `methods = list(...)` and
    from later `X$methods(...)` calls in the same file, documented by a `#'`
    block or a docstring (a string as the body's first statement). Inside its
    method bodies, bare names that are its fields or methods resolve to them
    before anything else.
  - Docs: classes use their block plus `@param`, then `@slot` (S4) or `@prop`
    (S7) or `@field` (reference classes), for constructor arguments, searched
    from the class up its chain; R6 classes use `@field` and `initialize`'s
    `@param`. A generic's page
    lists the workspace methods registered for it, and a generic with only
    documented methods is still documented. The manifest overlay is not used
    for these definitions, so the enhanced tier does not change them.
- **Members and slots** (`x$m`, `x$m(...)` and `x@s`, with `x` a plain
  identifier). `$` reaches R6 and reference class members, `@` S4 slots and
  S7 properties; members are found up the inheritance chain. `Class$new` is
  the constructor. In an R6 class body `self$m` and `private$m` are its public
  or private members and `super$m` its parent's; in a reference class
  `.self$m` is its member. Otherwise `x`'s class comes from the innermost
  scope that binds it: a parameter of a method definition takes the class
  it dispatches on (`setMethod(f, signature, function(x, ...))` by name or
  position, `setValidity(Class, function(object))`, `method(f, Class) <-
  function(x)`), any other parameter stops the search, and an earlier
  assignment in a statement list takes the class it constructs
  (`Class$new(...)`, `Class(...)`, `new("Class", ...)`). Any other `x` gives
  `None`.
- Unknown callees, `pkg::fn` callees and undocumented functions return `None`
  (Ark handles them). An undocumented function *with* a manifest topic is
  documented.
- **Manifest overlay**: a manifest topic is used only if its file's
  `content_hash` equals the content hash **or** the doc hash (§0) of the text
  currently indexed for that path; otherwise the static model is used. The
  extension sends doc hashes to the sidecar, which echoes them, so roxygen2's
  docs keep showing while a file has unsaved body-only edits.
- Lookups are independent of workspace size: the index keeps reverse maps
  (name -> defining paths, `@rdname` and `@describeIn` members) updated per
  file in `update_file`/`remove_file`. Inheritance expansion is memoised per
  resolution and capped at depth 16.

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
  fingerprints(): FileFingerprint[];            // sorted by path
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
      "content_hash": "0123456789abcdef",   // content hash or doc hash (§0) of the file's text
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

**Hello** (written once at startup, before any request, using base R only so
it works when jsonlite, roxygen2 or purrr is missing; if a required package is
missing, write it and exit with status 3):

```json
{"event":"hello","protocol":1,"r_version":"4.6.1","packages":{"roxygen2":"8.1.0","jsonlite":"2.0.0"},"missing":[],"ok":true}
```

**Requests** `{"id": <int>, "method": <string>, "params": {...}}`, answered by
exactly one `{"id": <same>, "result": {...}}` or
`{"id": <same>, "error": {"message": "..."}}`. Requests are processed in order.

- `build`
  - params: `{ "files": [{ "path": "...", "hash": "...", "text": "..."? }], "install": false, "lib_root": "/workspaceStorage/<session id>"? }`
    - `hash` is the file's **doc hash** (§0) and keys the sidecar's per-file
      cache: a body-only edit keeps the cached entry.
    - `text` is optional. The extension sends the indexed (live) text only for
      files whose `(path, hash)` the running sidecar process has not built yet;
      if `text` is absent and the cache has no entry for that hash, the file is
      read from disk.
    - The request lists the **complete** set of workspace files; files not
      listed are dropped from the cache.
    - The extension sends no request at all when every doc hash and the
      `lib_root` equal those of the last successful build, so R is not
      started for saves that cannot change any documentation.
  - result: `{ "manifest": <§3>, "lib_dir": "/.../lib-<gen>" | null, "topics": ["wmean", ...], "cache_hits": <int>, "errors": [{ "path": "...", "message": "..." }] }`
    - A file roxygen2 can't parse goes in `errors` and is omitted from the
      manifest; the rest of the build still succeeds.
    - `install: true` requires `lib_root`; it runs `R CMD INSTALL` of a
      generated `rozone.docs` package into a fresh `lib_root/lib-<gen>`. The
      sidecar never deletes generations; the extension owns cleanup (see §5).
    - `topics` is the sorted set of aliases in the generated package after
      collision resolution (smallest path wins), i.e. what the hover provider
      skips for call sites once injected.
    - An `R CMD INSTALL` failure does not fail the build: `lib_dir` is `null`
      and `errors` gets an entry with `path: "rozone.docs"`. Unchanged
      generated Rd (the winning topics' Rd files and text) reuses the
      previous `lib_dir` installed into the same `lib_root`, as long as that
      directory still exists.
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

Library ownership: each R session gets its own `lib_root`,
`<workspace storage>/<session id>/` (global storage `no-workspace/` when no
folder is open), so a loaded namespace never points into a directory that
another session or window cleans up. The extension deletes:

- the session's other `lib-<gen>` directories, only after a successful
  injection of the new one;
- the whole session directory when the session ends for good (not on
  `restart`, `transferred` or `extensionHost` exits);
- at startup, session directories that are not live and untouched for 24h.

Windows without a folder share `no-workspace/` but only see their own
sessions, so every window touches (mtime) the directories of its live R
sessions at startup and hourly; another window's sweep therefore never sees a
live session's directory as untouched.
