//! WebAssembly bindings of schema-explorer-core for the web viewer.

use wasm_bindgen::prelude::*;

/// The version of the core library.
#[wasm_bindgen]
pub fn version() -> String {
    schema_explorer_core::version().to_string()
}
