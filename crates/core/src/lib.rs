//! Core of schema-explorer: reads XML Schema (XSD) sets and JSON Schema
//! (draft-04 to 2020-12, also inside OpenAPI 3.x and AsyncAPI 2/3
//! documents, in JSON or YAML) into one indexed model for the viewer.
//!
//! The input is a set of in-memory files (name and bytes), so the same code
//! runs in the command line tool and, compiled to WebAssembly, in the
//! browser. Imports and includes are resolved relative to the including
//! file, among the given files or through an optional [`Resolver`].
//! Problems (unparsable files, unresolved imports or references) become
//! [diagnostics](bundle::Diagnostic) in the [`Bundle`]; indexing never fails.

pub mod bundle;
pub mod diff;
pub mod index;
pub mod input;
pub mod json;
pub mod report;
mod xsd;

pub use bundle::{Bundle, FORMAT, Id, Kind};
pub use diff::{DiffOptions, SchemaDiff, diff};
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

/// True when the files are a JSON Schema set (JSON or YAML files, none
/// of them XML).
pub fn is_json_schema_set(sources: &[Source]) -> bool {
    !sources.is_empty()
        && sources.iter().all(|s| {
            json::is_json_name(&s.name) && {
                let start = s.bytes.iter().find(|b| !b.is_ascii_whitespace());
                start != Some(&b'<') && !s.bytes.starts_with(&[0xEF, 0xBB, 0xBF, b'<'])
            }
        })
}

fn generator(opts: &Options) -> String {
    if opts.generator.is_empty() {
        format!("schema-explorer-core {}", version())
    } else {
        opts.generator.clone()
    }
}

/// Read a JSON Schema set (or OpenAPI / AsyncAPI documents) into a bundle.
pub fn index_json(
    sources: Vec<Source>,
    resolver: Option<&mut Resolver<'_>>,
    opts: &Options,
) -> Bundle {
    let mut diagnostics = Vec::new();
    let docs = json::load(sources, resolver, &mut diagnostics);
    let mut b = json::Builder::new(&docs);
    b.run();
    let file_infos = docs
        .iter()
        .enumerate()
        .map(|(i, d)| bundle::FileInfo {
            name: d.display.clone(),
            target_namespace: b.file_ns[i].map(|n| b.namespaces[n as usize].uri.clone()),
            namespace: b.file_ns[i],
            prefixes: Default::default(),
            version: d
                .value
                .as_ref()
                .and_then(|v| v.pointer("/info/version"))
                .and_then(|v| v.as_str())
                .map(str::to_string),
            dialect: (!d.label.is_empty()).then(|| d.label.clone()),
            element_form_qualified: false,
            attribute_form_qualified: false,
            input: d.input,
            directives: d
                .refs
                .iter()
                .map(|(loc, file)| bundle::Directive {
                    kind: bundle::DirectiveKind::Import,
                    namespace: None,
                    location: Some(loc.clone()),
                    file: file.map(|j| j as bundle::FileId),
                    via: None,
                    line: 0,
                })
                .collect(),
            docs: d
                .value
                .as_ref()
                .and_then(|v| {
                    v.get("description")
                        .or_else(|| v.pointer("/info/description"))
                })
                .and_then(|v| v.as_str())
                .map(|t| {
                    vec![bundle::Doc {
                        lang: None,
                        source: None,
                        text: t.to_string(),
                    }]
                })
                .unwrap_or_default(),
            components: b.file_globals[i],
        })
        .collect();
    diagnostics.append(&mut b.diagnostics);
    let mut components = std::mem::take(&mut b.components);
    index::links(&mut components, std::mem::take(&mut b.usages));
    index::effective(&mut components, &mut diagnostics);
    finish(
        bundle::Language::JsonSchema,
        file_infos,
        std::mem::take(&mut b.namespaces),
        components,
        diagnostics,
        b.unresolved_refs,
        opts,
    )
}

fn finish(
    language: bundle::Language,
    files: Vec<bundle::FileInfo>,
    namespaces: Vec<bundle::Namespace>,
    components: Vec<bundle::Component>,
    diagnostics: Vec<bundle::Diagnostic>,
    unresolved_refs: u32,
    opts: &Options,
) -> Bundle {
    let search = if opts.compact {
        Default::default()
    } else {
        index::search(&components)
    };
    let mut bundle = Bundle {
        format: FORMAT,
        language,
        generator: generator(opts),
        compact: false,
        files,
        namespaces,
        components,
        diagnostics,
        stats: Default::default(),
        search,
    };
    bundle.stats = index::stats(&bundle, unresolved_refs);
    if opts.compact {
        bundle.make_compact();
    }
    bundle
}

/// Read a schema set into a bundle: XSD, or JSON Schema when every file
/// is JSON or YAML (see [`is_json_schema_set`]).
pub fn index(sources: Vec<Source>, resolver: Option<&mut Resolver<'_>>, opts: &Options) -> Bundle {
    if is_json_schema_set(&sources) {
        return index_json(sources, resolver, opts);
    }
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
                dialect: None,
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
    finish(
        bundle::Language::Xsd,
        file_infos,
        std::mem::take(&mut b.namespaces),
        components,
        diagnostics,
        b.unresolved_refs,
        opts,
    )
}

/// Restore what [`Bundle::make_compact`] stripped: the effective content
/// models and the search index. Does nothing to a full bundle.
pub fn expand(bundle: &mut Bundle) {
    if !bundle.compact {
        return;
    }
    let mut diagnostics = Vec::new();
    index::effective(&mut bundle.components, &mut diagnostics);
    bundle.search = index::search(&bundle.components);
    bundle.compact = false;
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
