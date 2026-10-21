//! WebAssembly bindings of schema-explorer-core for the web viewer.

use schema_explorer_core::{Options, Source};
use wasm_bindgen::prelude::*;

/// Index a schema set (XSD, or JSON Schema / OpenAPI / AsyncAPI in JSON
/// or YAML) and return the bundle as JSON.
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

/// Expand a compact bundle (JSON) into the full form: effective content
/// models and the search index are recomputed. A full bundle comes back as is.
#[wasm_bindgen]
pub fn expand(json: &str) -> Result<String, JsValue> {
    let mut bundle: schema_explorer_core::Bundle =
        serde_json::from_str(json).map_err(|e| JsValue::from_str(&e.to_string()))?;
    if !bundle.compact {
        return Ok(json.to_string());
    }
    schema_explorer_core::expand(&mut bundle);
    schema_explorer_core::to_json(&bundle).map_err(|e| JsValue::from_str(&e.to_string()))
}

fn err(e: impl ToString) -> JsValue {
    JsValue::from_str(&e.to_string())
}

/// Compare two bundles (JSON, full or compact; `old` is the earlier
/// version) and return the diff as JSON. `options` is a JSON object of
/// `DiffOptions` fields, or empty for the defaults.
#[wasm_bindgen]
pub fn diff(old: &str, new: &str, options: &str) -> Result<String, JsValue> {
    let a: schema_explorer_core::Bundle = serde_json::from_str(old).map_err(err)?;
    let b: schema_explorer_core::Bundle = serde_json::from_str(new).map_err(err)?;
    let opts: schema_explorer_core::DiffOptions = if options.trim().is_empty() {
        Default::default()
    } else {
        serde_json::from_str(options).map_err(err)?
    };
    let mut d = schema_explorer_core::diff(&a, &b, &opts);
    d.generator = format!("schema-explorer-wasm {}", env!("CARGO_PKG_VERSION"));
    serde_json::to_string(&d).map_err(err)
}

/// Render a diff (JSON) as a report: `md` or `html`.
#[wasm_bindgen]
pub fn diff_report(diff: &str, format: &str) -> Result<String, JsValue> {
    let d: schema_explorer_core::SchemaDiff = serde_json::from_str(diff).map_err(err)?;
    match format {
        "md" => Ok(schema_explorer_core::report::markdown(&d)),
        "html" => Ok(schema_explorer_core::report::html(&d)),
        _ => Err(err(format!("unknown report format {format}"))),
    }
}

/// The schema at a JSON pointer of a JSON or YAML file, as indented JSON
/// (the source view of a JSON Schema component).
#[wasm_bindgen]
pub fn json_source(name: &str, text: &str, pointer: &str) -> Result<String, JsValue> {
    schema_explorer_core::json::source(name, text.as_bytes(), pointer)
        .ok_or_else(|| err(format!("{pointer} not found in {name}")))
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
