# Changelog

## Unreleased

- Initial version (0.1.0 in development, not yet published).
- Base tier: hover and signature help from roxygen comments in plain R scripts,
  powered by a Rust parser compiled to WebAssembly. No R is run.
- Enhanced tier (trusted workspaces): a warm R sidecar builds roxygen2-exact docs
  and resolves cross-package `@inheritParams`.
- Positron: script docs available to `?fn`, the Help pane and Ark's completions
  via an injected `rozone.docs` namespace (`rozone.helpInjection`).
- Hovers and the documentation preview use the same layout as Ark's R help
  hovers: topic, title, then Description, Usage, Arguments, Value and Examples.
- Commands: Open Documentation, Show Output, Restart R Sidecar.
