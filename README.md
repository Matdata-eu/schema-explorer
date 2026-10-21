# schema-explorer

A visual explorer for XML Schema (XSD), and later JSON Schema, that runs in the
browser and can be published as a static site (GitHub Pages). It is the
schema counterpart of [ontology-explorer](https://github.com/Matdata-eu/ontology-explorer).

**Status: early development.** The viewer works on real schema sets (NeTEx,
railML); expect changes.

Website, with NeTEx, ERA TAF/TAP TSI, OASIS UBL and the W3C schema for
schemas as examples: <https://matdata-eu.github.io/schema-explorer/>

![The page of a NeTEx complex type: derivation chain and class diagram](docs/screenshot-type.png)

## Features

- **Open** `.xsd` files or whole folders by drag and drop or the file picker:
  they are indexed in the browser (WebAssembly, in a worker), nothing is
  uploaded. Or open a pre-built bundle by its address (`?bundle=<url>`), or
  pick an example.
- **Sidebar**: complex types, simple types, global elements, groups and
  attribute groups, and files, per namespace; search over names,
  documentation and enumeration values. Lists are virtualised, so NeTEx's
  2,600 complex types scroll smoothly.
- **Type pages**: documentation, the derivation chain and derived types, the
  effective content model (child elements with cardinality and type,
  `sequence` / `choice` / `all` and groups, inherited rows grouped per base
  type and foldable), attributes (type, use, default or fixed), facets and
  enumerations with their documentation, identity constraints, where used,
  the source file and line, and the XSD of the component with linked names.
- **Element pages** (global and local): type, substitution group head and
  members, nillable, abstract, default or fixed, where used.
- **Simple type pages**: restriction facets, enumeration table, list item and
  union member types.
- **Class diagrams** (laid out with ELK, drawn as SVG): a type with its
  attributes and simple-typed children, generalisation arrows for extension
  and restriction, composition arrows with multiplicities for complex-typed
  child elements, «enumeration» boxes, the types and elements that use it.
  Double-click to add neighbours; depth, direction, full screen, export to
  SVG, PNG, PlantUML and Mermaid.
- **Content-model trees** in the style of XML editors, expanded on demand.
- **Overview map** of the complex types of a namespace or a folder of files.
- **Share links** that restore the page, the diagram's options, added boxes,
  open tree nodes and zoom; light and dark themes; a short manual (Help).

![The content tree of a NeTEx type](docs/screenshot-tree.png)

![The overview map of the NeTEx IFOPT part](docs/screenshot-overview.png)

## Running it locally

```sh
schema-explorer serve path/to/schemas/            # every .xsd file in the folder
schema-explorer serve main.xsd --bind 0.0.0.0:8080 --no-open
```

`serve` indexes the files once, opens the embedded viewer on them and serves
their source for the XSD view. Without files, the viewer opens empty and
indexes what you drop on it.

Planned: comparing two versions of a schema set, JSON Schema, a Docker image
and the `<schema-explorer>` web component on npm (`@matdata/schema-explorer`).

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

## Publishing a schema set

`scripts/build-examples.sh <cli> <dist>` shows how the website is built: it
pre-indexes a schema set into `bundle.json` and puts its `.xsd` files next
to it (for the source view). Any static host works:
`index.html?bundle=examples/netex/bundle.json&sources=examples/netex/xsd/`.
Only publish schemas whose licence allows it.

The website's examples are fetched from their publishers at build time and
keep their own terms: NeTEx (GPL-3.0, NeTEx-CEN); TAF TSI and TAP TSI B.10
schemas, source: European Union Agency for Railways (reproduction authorised,
source acknowledged); UBL 2.4, copyright © OASIS Open 2024 (OASIS IPR
Policy); XMLSchema.xsd and xml.xsd, copyright © W3C (W3C Document License).
See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

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
