//! Pure-Rust roxygen documentation for R scripts. See `docs/contracts.md` §1.

mod call;
mod extract;
mod index;
mod manifest;
mod markdown;
mod resolve;
mod roxygen;
mod strip;
mod text;

use serde::Serialize;

pub use index::Index;
pub use text::content_hash;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Range {
    pub start: u32,
    pub end: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum HoverKind {
    Call,
    Definition,
    Identifier,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DocSource {
    Static,
    Manifest,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hover {
    pub name: String,
    pub kind: HoverKind,
    pub markdown: String,
    pub range: Range,
    pub source: DocSource,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParameterInfo {
    pub label: [u32; 2],
    pub documentation: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignatureHelp {
    pub name: String,
    pub label: String,
    pub documentation: String,
    pub parameters: Vec<ParameterInfo>,
    pub active_parameter: Option<u32>,
    pub source: DocSource,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FunctionSummary {
    pub name: String,
    pub path: String,
    pub range: Range,
    pub title: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManifestError(pub String);

impl std::fmt::Display for ManifestError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "invalid manifest: {}", self.0)
    }
}

impl std::error::Error for ManifestError {}

/// Public for tooling and tests; the stable surface is [`Index`].
pub mod internals {
    pub use crate::call::match_args;
    pub use crate::markdown::convert_links;
    pub use crate::roxygen::{Block, parse_block};
    pub use crate::strip::strip_r_code;
    pub use crate::text::TextMap;
}
