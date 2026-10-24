# rozone: roxygen docs for R scripts

Write roxygen comments above a function in a plain `.R` script and get hover
docs and signature help wherever you call it. No setup, no packages to load.

```r
#' Weighted mean of a column
#'
#' @param x A numeric vector.
#' @param w Weights, the same length as `x`.
#' @returns A length-1 double.
wmean <- function(x, w = rep(1, length(x))) {
  sum(x * w) / sum(w)
}

wmean(survey$income, w = survey$weight)   # hover and signature help work here
```

## Two tiers

rozone always runs the **base tier**. In a trusted workspace with R installed
it can also run the **enhanced tier**.

| Feature | Base (untrusted, or no R) | Enhanced: VS Code | Enhanced: Positron |
|---|---|---|---|
| Hover: call sites, definitions, bare identifiers | Yes | Yes | Yes |
| Signature help: description, per-argument docs, active argument | Yes | Yes | Yes |
| Workspace-local `@inheritParams` / `@inherit` / `@describeIn` | Yes | Yes | Yes |
| Cross-package `@inheritParams dplyr::mutate`, `@inheritDotParams`, `@inheritSection` | Pointer only | Resolved | Resolved |
| Text fidelity | rozone's roxygen subset | roxygen2-exact (saved files) | roxygen2-exact |
| `?fn`, F1, Help pane | Markdown preview command | Markdown preview command | Yes |
| Docs in Ark's completion list | No | n/a | Yes |
| Argument docs when Ark's signature popup wins | No | n/a | Yes |
| Runs any R | Never | rozone's own sidecar only | rozone's sidecar, plus one `loadNamespace` call in your session |

The base tier is a Rust parser compiled to WebAssembly. It does not start any
process. If R or roxygen2 is missing, the sidecar crashes, or the workspace is
not trusted, you still get hover and signature help.

## Workspace trust

rozone follows VS Code's [Workspace Trust](https://code.visualstudio.com/docs/editor/workspace-trust) model.

- **Untrusted workspaces:** only the base tier runs. rozone parses your files
  and never runs R. Workspace settings cannot change `rozone.r.path` or
  `rozone.enhanced.enabled`, so a cloned repository cannot point rozone at a
  different program or turn the enhanced tier on.
- **Trusted workspaces:** the enhanced tier starts if R is found and
  `roxygen2` is installed. Granting trust starts it without a reload.
  Revoking trust restarts the extension host and stops the sidecar.

## Requirements for the enhanced tier

- R, found in this order: the Positron session's R, then `rozone.r.path`, then
  `Rscript` on your `PATH`.
- The `roxygen2` and `jsonlite` packages in that R's library. If either is
  missing, rozone stays in the base tier and shows one notification.

The sidecar starts with `--no-init-file`, so a project `.Rprofile` does not run
in it. In Positron it uses the library paths of your live session. In VS Code
it starts without `--no-init-file`, so a renv `.Rprofile` can activate the
project library.

The sidecar uses about 120 MB of memory while it runs. It stops after
`rozone.sidecar.idleTimeoutMinutes` with no saves and restarts on the next save.

## Positron help injection

In Positron, with `rozone.helpInjection` enabled (the default), rozone installs
a generated `rozone.docs` package into its own storage folder and loads it into
your R session. This is what makes `?fn`, the Help pane and Ark's completion
docs show script docs.

Footprint: one extra namespace, `rozone.docs`, with no exports. It appears in
`loadedNamespaces()` and `sessionInfo()`. rozone never starts an R session for
you. It only loads into a session that is already running, and retries when the
session is idle. Set `rozone.helpInjection` to `false` to turn this off.

## Settings

| Setting | Default | Description |
|---|---|---|
| `rozone.enhanced.enabled` | `true` | In trusted workspaces, run a background R process with roxygen2 for roxygen2-exact docs and cross-package inheritance. Restricted in untrusted workspaces. |
| `rozone.r.path` | `""` | Path to `Rscript`. Empty uses the Positron session's R, then `Rscript` on `PATH`. Restricted in untrusted workspaces. |
| `rozone.sidecar.idleTimeoutMinutes` | `10` | Stop the R sidecar after this many idle minutes. |
| `rozone.helpInjection` | `true` | In Positron, load script docs into the R session so `?fn`, the Help pane and Ark's completions show them. |
| `rozone.files.exclude` | `**/renv/**`, `**/packrat/**`, `**/node_modules/**`, `**/.git/**` | Glob patterns of R files not to index. |

## Commands

| Command | Description |
|---|---|
| `rozone: Open Documentation` | Open the documentation for a documented function in a Markdown preview. |
| `rozone: Show Output` | Show the rozone output channel. |
| `rozone: Restart R Sidecar` | Restart the R sidecar (enhanced tier only). |

## Known limitations

1. **Inline R in roxygen is stripped, in both tiers.** This covers inline
   `` `r ...` ``, ```` ```{r} ```` chunks, `@eval`, `@evalRd`, `@evalNamespace`
   and `@includeRmd`. rozone shows the text with that code removed. Your docs
   code is never executed.
2. **Base tier only** (untrusted workspace, or no R or roxygen2):
   - no `?fn` or Help pane;
   - no Ark completion docs;
   - no cross-package inheritance (a pointer is shown instead);
   - rozone's roxygen subset, not roxygen2's output;
   - for functions that have already been run, argument docs depend on signature
     help ordering with Ark.
3. **Enhanced tier:**
   - about 120 MB for the sidecar while it is active;
   - needs `roxygen2` and `jsonlite`;
   - Positron injection adds a visible `rozone.docs` namespace;
   - script docs do not appear in Help-pane search.
4. Only top-level definitions of the form `name <- function(...)` are
   documented. `=`, `<<-` and `function(...) -> name` also count. Not covered:
   `purrr::partial()`, `memoise()`, `local()`, R6, S7 and S4 methods.
5. Names follow R's masking rules. A documented `filter` in your script takes
   over hover for `filter(` calls.

## Privacy and security

- rozone reads the text of the R files in your workspace (excluding
  `rozone.files.exclude`) to build its index. It does this in the extension
  host, on your machine. It sends nothing over the network.
- The base tier never starts a process.
- The enhanced tier runs R only in trusted workspaces. The sidecar only parses
  roxygen comments and evaluates `function(...)` literals in a sandbox. It
  does not run function bodies, default arguments, or any R code embedded in
  roxygen comments.

## License

MIT. See the LICENSE file in the repository.
