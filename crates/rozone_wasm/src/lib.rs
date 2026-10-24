//! wasm-bindgen wrapper around `rozone_core`. JS surface: `docs/contracts.md` §2.

use rozone_core::{Index, content_hash as core_content_hash};
use serde::Serialize;
use serde_wasm_bindgen::Serializer;
use wasm_bindgen::prelude::*;

#[wasm_bindgen(typescript_custom_section)]
const TS_TYPES: &str = r#"
export type HoverKind = "call" | "definition" | "identifier";
export type DocSource = "static" | "manifest";

export interface Range {
  start: number;
  end: number;
}

export interface Hover {
  name: string;
  kind: HoverKind;
  markdown: string;
  range: Range;
  source: DocSource;
}

export interface ParameterInfo {
  label: [number, number];
  documentation: string;
}

export interface SignatureHelp {
  name: string;
  label: string;
  documentation: string;
  parameters: ParameterInfo[];
  activeParameter: number | null;
  source: DocSource;
}

export interface FunctionSummary {
  name: string;
  path: string;
  range: Range;
  title: string | null;
}
"#;

fn to_js<T: Serialize>(value: &T) -> Result<JsValue, JsError> {
    value
        .serialize(&Serializer::json_compatible())
        .map_err(|error| JsError::new(&error.to_string()))
}

#[wasm_bindgen]
pub struct RozoneIndex {
    inner: Index,
}

impl Default for RozoneIndex {
    fn default() -> Self {
        Self::new()
    }
}

#[wasm_bindgen]
impl RozoneIndex {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        console_error_panic_hook::set_once();
        Self {
            inner: Index::new(),
        }
    }

    #[wasm_bindgen(js_name = updateFile)]
    pub fn update_file(&mut self, path: &str, text: &str) {
        self.inner.update_file(path, text);
    }

    #[wasm_bindgen(js_name = removeFile)]
    pub fn remove_file(&mut self, path: &str) {
        self.inner.remove_file(path);
    }

    #[wasm_bindgen(js_name = loadManifest)]
    pub fn load_manifest(&mut self, json: &str) -> Result<(), JsError> {
        self.inner
            .load_manifest(json)
            .map_err(|error| JsError::new(&error.to_string()))
    }

    #[wasm_bindgen(js_name = clearManifest)]
    pub fn clear_manifest(&mut self) {
        self.inner.clear_manifest();
    }

    #[wasm_bindgen(unchecked_return_type = "Hover | undefined")]
    pub fn hover(&self, path: &str, offset: u32) -> Result<Option<JsValue>, JsError> {
        self.inner
            .hover(path, offset)
            .as_ref()
            .map(to_js)
            .transpose()
    }

    #[wasm_bindgen(js_name = signatureHelp, unchecked_return_type = "SignatureHelp | undefined")]
    pub fn signature_help(&self, path: &str, offset: u32) -> Result<Option<JsValue>, JsError> {
        self.inner
            .signature_help(path, offset)
            .as_ref()
            .map(to_js)
            .transpose()
    }

    #[wasm_bindgen(js_name = documentation)]
    pub fn documentation(&self, name: &str, from_path: Option<String>) -> Option<String> {
        self.inner.documentation(name, from_path.as_deref())
    }

    #[wasm_bindgen(js_name = documentedFunctions, unchecked_return_type = "FunctionSummary[]")]
    pub fn documented_functions(&self) -> Result<JsValue, JsError> {
        to_js(&self.inner.documented_functions())
    }
}

#[wasm_bindgen(js_name = contentHash)]
pub fn content_hash(text: &str) -> String {
    core_content_hash(text)
}

#[wasm_bindgen(js_name = version)]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_owned()
}
