# Third-party notices

schema-explorer is © 2026 Mathias Vanden Auweele ([MatData](https://matdata.eu/)),
licensed under the [Apache License 2.0](LICENSE). Source code, questions, bug
reports and feature requests: <https://github.com/Matdata-eu/schema-explorer/issues>.

This file is a placeholder during early development. It is regenerated from
`about.hbs` with [cargo-about](https://github.com/EmbarkStudios/cargo-about)
before releases:

    cargo about generate about.hbs -o THIRD_PARTY_NOTICES.md

## Web viewer

The web viewer (in the binary, on the website and in the npm package)
includes:

| Component | Version | Licence | Used for |
|---|---|---|---|
| [ELK.js](https://github.com/kieler/elkjs), the JavaScript build of the [Eclipse Layout Kernel](https://eclipse.dev/elk/) | 0.12.0 | EPL-2.0 | the diagram layout worker |
| [Barlow](https://github.com/jpt/barlow) font, latin subset via [Fontsource](https://fontsource.org) | 5.3.0 | OFL-1.1 | the viewer's text |
| [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono) font, latin subset via [Fontsource](https://fontsource.org) | 5.3.0 | OFL-1.1 | names and code in the viewer |

ELK.js is distributed unmodified; its source code is available at
<https://github.com/kieler/elkjs> and <https://github.com/eclipse/elk>.

The example schemas on the website are fetched from their publishers at build
time (see `scripts/build-examples.sh`) and published with their own terms;
they are not part of this repository or the binary:

- **NeTEx**, from <https://github.com/NeTEx-CEN/NeTEx>, GPL-3.0.
- **TAF TSI** (4.0, and technical documents baseline 3.5.0), **TAP TSI
  B.10** (1.4) and legacy **RINF** XML schemas. Source: European Union Agency for Railways,
  <https://www.era.europa.eu>. "Reproduction is authorised, provided the
  source is acknowledged" ([ERA disclaimer and copyright notice](https://www.era.europa.eu/content/disclaimer-and-copyright-notice)).
- **UBL 2.4**, Universal Business Language Version 2.4, OASIS Standard,
  <https://docs.oasis-open.org/ubl/os-UBL-2.4/>. Copyright © OASIS Open 2024.
  All Rights Reserved. Distributed under the
  [OASIS IPR Policy](https://www.oasis-open.org/policies-guidelines/ipr/).
- **XML Schema** schema for schemas, <https://www.w3.org/2001/XMLSchema.xsd>
  with <https://www.w3.org/2001/xml.xsd>. Copyright © World Wide Web
  Consortium. Used under the
  [W3C Document License](https://www.w3.org/copyright/document-license-2023/).
- **OSDM**, the UIC Open Sales and Distribution Model specification (OpenAPI
  and JSON schemas), from
  <https://github.com/UnionInternationalCheminsdeFer/OSDM>, Apache-2.0.
- **JSON Schema 2020-12** meta-schemas, <https://json-schema.org/draft/2020-12>.
  Copyright © 2022 JSON Schema Specification Authors. BSD-3-Clause
  (<https://github.com/json-schema-org/json-schema-spec>).
