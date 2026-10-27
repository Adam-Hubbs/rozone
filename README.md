# rozone

Rozone brings the rich hover and help from R packages using Roxygen to non-package scripts. 
Rozone has two tiers:

- **Base tier** (`rozone_core` through `rozone_wasm`) is always on and never
  runs code. It is the only tier in untrusted workspaces.
- **Enhanced tier** (`editors/code/r/sidecar.R`) is a warm R process that builds
  roxygen2 output and a manifest for the Rust core. It runs only in trusted
  workspaces, and in Positron it also injects a `rozone.docs` package into the
  user's session.

## License

MIT. See [LICENSE](LICENSE).
