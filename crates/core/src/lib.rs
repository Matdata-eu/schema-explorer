//! Core of schema-explorer: reads XML Schema (XSD) sets, and later JSON Schema,
//! into one indexed model for the viewer.
//!
//! The input is a set of in-memory files (name and bytes), so the same code
//! runs in the command line tool and, compiled to WebAssembly, in the
//! browser. Imports and includes are resolved relative to the including
//! file, among the given files or through an optional [`Resolver`].
//! Problems (unparsable files, unresolved imports or references) become
//! [diagnostics](bundle::Diagnostic) in the [`Bundle`]; indexing never fails.

pub mod bundle;
pub mod index;
pub mod input;
mod xsd;

pub use bundle::{Bundle, FORMAT, Id, Kind};
pub use input::{Resolver, Source};

/// Indexing options.
#[derive(Debug, Clone, Default)]
pub struct Options {
    /// Written to [`Bundle::generator`].
    pub generator: String,
    /// Write the compact form (see [`Bundle::make_compact`]).
    pub compact: bool,
}

/// The version of this crate.
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// Read an XSD set into a bundle.
pub fn index(sources: Vec<Source>, resolver: Option<&mut Resolver<'_>>, opts: &Options) -> Bundle {
    let mut diagnostics = Vec::new();
    let files = input::load(sources, resolver, &mut diagnostics);
    let docs: Vec<Option<roxmltree::Document>> = files
        .iter()
        .map(|f| {
            f.ok.then(|| {
                roxmltree::Document::parse_with_options(&f.text, input::parse_options()).ok()
            })
            .flatten()
        })
        .collect();
    let mut b = xsd::Builder::new(&files);
    b.run(&docs);
    let file_infos: Vec<bundle::FileInfo> = files
        .iter()
        .enumerate()
        .map(|(i, f)| {
            let root_el = docs[i].as_ref().map(|d| d.root_element());
            bundle::FileInfo {
                name: f.display.clone(),
                target_namespace: f.target_namespace.clone(),
                namespace: b.file_ns[i],
                prefixes: docs[i]
                    .as_ref()
                    .map(xsd::Builder::file_prefixes)
                    .unwrap_or_default(),
                version: root_el
                    .and_then(|r| r.attribute("version"))
                    .map(str::to_string),
                element_form_qualified: root_el
                    .is_some_and(|r| r.attribute("elementFormDefault") == Some("qualified")),
                attribute_form_qualified: root_el
                    .is_some_and(|r| r.attribute("attributeFormDefault") == Some("qualified")),
                input: f.input,
                directives: f
                    .directives
                    .iter()
                    .map(|d| bundle::Directive {
                        kind: d.kind,
                        namespace: d.namespace.clone(),
                        location: d.location.clone(),
                        file: d.file.map(|j| j as bundle::FileId),
                        via: d.via.map(str::to_string),
                        line: d.line,
                    })
                    .collect(),
                docs: root_el.map(|r| xsd::annotations(&r).0).unwrap_or_default(),
                components: b.file_globals[i],
            }
        })
        .collect();
    diagnostics.append(&mut b.diagnostics);
    let mut components = std::mem::take(&mut b.components);
    index::links(&mut components, std::mem::take(&mut b.usages));
    index::effective(&mut components, &mut diagnostics);
    let search = if opts.compact {
        Default::default()
    } else {
        index::search(&components)
    };
    let mut bundle = Bundle {
        format: FORMAT,
        generator: if opts.generator.is_empty() {
            format!("schema-explorer-core {}", version())
        } else {
            opts.generator.clone()
        },
        compact: false,
        files: file_infos,
        namespaces: std::mem::take(&mut b.namespaces),
        components,
        diagnostics,
        stats: Default::default(),
        search,
    };
    bundle.stats = index::stats(&bundle, b.unresolved_refs);
    if opts.compact {
        bundle.make_compact();
    }
    bundle
}

/// Serialize a bundle as JSON (no whitespace).
pub fn to_json(bundle: &Bundle) -> serde_json::Result<String> {
    serde_json::to_string(bundle)
}

/// Serialize a bundle as indented JSON.
pub fn to_json_pretty(bundle: &Bundle) -> serde_json::Result<String> {
    serde_json::to_string_pretty(bundle)
}

#[cfg(test)]
mod tests {
    #[test]
    fn version_is_set() {
        assert!(!super::version().is_empty());
    }
}
