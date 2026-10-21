# schema-explorer

A visual explorer for XML Schema (XSD), and later JSON Schema, that runs in the
browser and can be published as a static site (GitHub Pages). It is the
schema counterpart of [ontology-explorer](https://github.com/Matdata-eu/ontology-explorer).

**Status: early development.** Nothing usable yet; the parser and viewer are
being built.

Website: <https://matdata-eu.github.io/schema-explorer/>

## Planned features

- UML-like diagrams of complex types, elements and their relations
- A readable page per type, element, attribute group and model group
- Content-model trees (sequence / choice / all, cardinalities, substitution groups)
- Search across all components
- Following `include`, `import` and `ref` across files and namespaces
- Comparing two versions of a schema set
- A command-line tool (`schema-explorer serve` / `index`), a Docker image and
  an embeddable `<schema-explorer>` web component (`@matdata/schema-explorer`)

## Indexing a schema set

The core reads an XSD set (XSD 1.0, tolerating 1.1 constructs) into one JSON
bundle for the viewer: every global and local component keyed by qualified
name and source file and line, with documentation, references resolved to
ids, "where used" back-references, derived types, substitution group
members, effective content models and a search index.

```sh
schema-explorer index path/to/NeTEx_publication.xsd -o bundle.json
schema-explorer index schemas/ --compact -o bundle.json   # directories are read recursively
```

Imports and includes are followed from disk; a location that cannot be
found falls back to an input file with the imported namespace or the same
file name, and otherwise becomes an `unresolved-import` diagnostic in the
bundle. The bundle format is versioned (`format`, see
`crates/core/src/bundle.rs`); `--compact` leaves out the parts the viewer
can recompute. In the browser, the WebAssembly build exposes
`index(names, contents, compact)` with the same output.

## Layout

- `crates/core`: Rust library that reads schema sets into an indexed model
- `crates/cli`: the `schema-explorer` command-line tool, with the viewer embedded
- `crates/wasm`: the core compiled to WebAssembly for the browser
- `web/`: the TypeScript/Vite viewer

## Development

```sh
cargo test
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version <version of wasm-bindgen in Cargo.lock>
cd web && npm ci && npm run build
```

### Test fixtures

Tests on real-world schemas read them from the directory in `SCHEMA_FIXTURES`
(default `tests/fixtures`, gitignored) and are skipped when absent.
`scripts/fetch-fixtures.sh` fetches the public [NeTEx](https://github.com/NeTEx-CEN/NeTEx)
schemas there; the tests also look for `railml/<version>/{schema,codelists}`
and `telematics/{netex,taf,taf-v3.5.1,b5,b10}`. For timings, run
`cargo test --release --test fixtures -- --nocapture`. Schemas whose licence forbids redistribution (such as railML)
must never be committed.

## Licence

[Apache License 2.0](LICENSE). © 2026 Mathias Vanden Auweele ([MatData](https://matdata.eu/)).
See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for included third-party software.
