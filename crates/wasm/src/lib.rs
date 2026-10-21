//! WebAssembly bindings of schema-explorer-core for the web viewer.

use schema_explorer_core::{Options, Source};
use wasm_bindgen::prelude::*;

/// Index an XSD set and return the bundle as JSON.
///
/// `names` and `contents` are parallel arrays: file paths (relative paths
/// let imports and includes resolve; bare file names resolve by name) and
/// their bytes as `Uint8Array`s. `compact` writes the compact form. Problems
/// in the schemas are reported in the bundle's `diagnostics`.
#[wasm_bindgen]
pub fn index(
    names: Vec<String>,
    contents: Vec<js_sys::Uint8Array>,
    compact: bool,
) -> Result<String, JsValue> {
    if names.len() != contents.len() {
        return Err(JsValue::from_str("names and contents differ in length"));
    }
    let sources = names
        .into_iter()
        .zip(contents)
        .map(|(name, bytes)| Source::new(name, bytes.to_vec()))
        .collect();
    let opts = Options {
        generator: format!("schema-explorer-wasm {}", env!("CARGO_PKG_VERSION")),
        compact,
    };
    let bundle = schema_explorer_core::index(sources, None, &opts);
    schema_explorer_core::to_json(&bundle).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// The version of the core library.
#[wasm_bindgen]
pub fn version() -> String {
    schema_explorer_core::version().to_string()
}

/// The bundle format version this build writes.
#[wasm_bindgen]
pub fn format() -> u32 {
    schema_explorer_core::FORMAT
}
