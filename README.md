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
schemas there. Schemas whose licence forbids redistribution (such as railML)
must never be committed.

## Licence

[Apache License 2.0](LICENSE). © 2026 Mathias Vanden Auweele ([MatData](https://matdata.eu/)).
See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for included third-party software.
