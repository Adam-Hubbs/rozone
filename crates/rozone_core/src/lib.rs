//! Pure-Rust roxygen documentation for R scripts. See `docs/contracts.md` §1.

use serde::Serialize;

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

#[derive(Debug, Default)]
pub struct Index {}

impl Index {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn update_file(&mut self, _path: &str, _text: &str) {
        todo!()
    }

    pub fn remove_file(&mut self, _path: &str) {
        todo!()
    }

    pub fn load_manifest(&mut self, _json: &str) -> Result<(), ManifestError> {
        todo!()
    }

    pub fn clear_manifest(&mut self) {
        todo!()
    }

    pub fn hover(&self, _path: &str, _offset: u32) -> Option<Hover> {
        todo!()
    }

    pub fn signature_help(&self, _path: &str, _offset: u32) -> Option<SignatureHelp> {
        todo!()
    }

    pub fn documentation(&self, _name: &str, _from_path: Option<&str>) -> Option<String> {
        todo!()
    }

    pub fn documented_functions(&self) -> Vec<FunctionSummary> {
        todo!()
    }
}

pub fn content_hash(text: &str) -> String {
    let hash = text.bytes().fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(0x0000_0100_0000_01b3)
    });
    format!("{hash:016x}")
}
