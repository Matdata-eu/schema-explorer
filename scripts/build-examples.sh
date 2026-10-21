#!/usr/bin/env bash
# Builds the examples catalog of the Pages site into <dist>/examples/:
# a pre-indexed bundle per schema set, its .xsd files (for the source view)
# and examples.json, which the open page lists.
#
# Only freely redistributable schema sets go here, each fetched from its
# publisher at build time (pinned URLs, cached in $WORK/downloads):
#   - NeTEx (GPL-3.0), from its public repository
#   - ERA TAF TSI and TAP TSI B.10 schemas (ERA: reproduction authorised,
#     source acknowledged)
#   - OASIS UBL 2.4 (OASIS IPR Policy)
#   - W3C XML Schema for schemas (W3C document licence)
# Never add railML (CC BY-NC-ND) or other schemas whose licence forbids
# redistribution. An example whose download fails is left out with a warning.
#
#   scripts/build-examples.sh <schema-explorer binary> <dist dir>
set -euo pipefail
CLI=$(realpath "$1")
DIST=$(realpath "$2")
cd "$(dirname "$0")/.."
WORK="${SCHEMA_FIXTURES:-tests/fixtures}"
DL="$WORK/downloads"
mkdir -p "$WORK" "$DL" "$DIST/examples"
ENTRIES=()

# fetch <url> <file in $DL>: download once (kept as a build cache), with retries.
fetch() {
  [ -s "$DL/$2" ] && return 0
  curl -fsSL --retry 4 --retry-delay 2 --retry-all-errors -o "$DL/$2.part" "$1" && mv "$DL/$2.part" "$DL/$2"
}

# entry <id> <title> <description> <version> <publisher> <licence> <link> [focus]
entry() {
  local focus=""
  [ -n "${8:-}" ] && focus=$(printf ',\n    "focus": "%s"' "$8")
  ENTRIES+=("$(printf '  {\n    "id": "%s",\n    "title": "%s",\n    "description": "%s",\n    "version": "%s",\n    "publisher": "%s",\n    "licence": "%s",\n    "link": "%s",\n    "src": "%s/bundle.json",\n    "sources": "%s/xsd/"%s\n  }' "$1" "$2" "$3" "$4" "$5" "$6" "$7" "$1" "$1" "$focus")")
}

# start <id>: a fresh output directory for an example.
start() {
  OUT="$DIST/examples/$1"
  rm -rf "$OUT"
  mkdir -p "$OUT/xsd"
}

if [ ! -d "$WORK/NeTEx/.git" ]; then
  git clone --depth 1 https://github.com/NeTEx-CEN/NeTEx "$WORK/NeTEx"
fi
NETEX_REV=$(git -C "$WORK/NeTEx" rev-parse --short HEAD)
start netex
rmdir "$OUT/xsd"
cp -r "$WORK/NeTEx/xsd" "$OUT/xsd"
cp "$WORK/NeTEx/LICENSE" "$OUT/LICENSE"
"$CLI" index "$OUT/xsd/NeTEx_publication.xsd" -o "$OUT/bundle.json"

entry netex "NeTEx" "Network Timetable Exchange, the CEN standard for public transport data (NeTEx_publication.xsd)" "$NETEX_REV" \
  "CEN TC278 · NeTEx-CEN" "GPL-3.0" "https://github.com/NeTEx-CEN/NeTEx" "ct/netex:StopPlace_VersionStructure"

# ERA TAF TSI, technical documents baseline 3.5.0 (message catalogue XML schema).
ERA="Source: European Union Agency for Railways (https://www.era.europa.eu). Reproduction is authorised, provided the source is acknowledged."
TAF=https://www.era.europa.eu/system/files/2024-06
if fetch $TAF/taf_cat_complete.xsd taf-3.5.0-taf_cat_complete.xsd &&
  fetch $TAF/taf_cat_codelists_0.xsd taf-3.5.0-taf_cat_codelists.xsd &&
  fetch $TAF/TAP_TSI_codelist.xsd taf-3.5.0-TAP_TSI_codelist.xsd; then
  start taf-tsi
  for f in taf_cat_complete taf_cat_codelists TAP_TSI_codelist; do cp "$DL/taf-3.5.0-$f.xsd" "$OUT/xsd/$f.xsd"; done
  echo "$ERA" > "$OUT/NOTICE"
  "$CLI" index "$OUT/xsd/taf_cat_complete.xsd" -o "$OUT/bundle.json"
  entry taf-tsi "TAF TSI" "Telematics Applications for Freight: the common message catalogue of the ERA technical documents (taf_cat_complete.xsd)" "3.5.0" \
    "European Union Agency for Railways" "ERA, source acknowledged" "https://www.era.europa.eu/node/2591"
else echo "warning: TAF TSI schemas not downloaded, example left out" >&2; fi

# ERA TAP TSI B.10 (assistance for persons with reduced mobility), the latest published XSD (archive baseline 1.4.2).
if fetch https://www.era.europa.eu/system/files/2022-11/tap_tsi_b.10_1.4_1.xsd tap-b10-1.4.xsd; then
  start tap-tsi-b10
  cp "$DL/tap-b10-1.4.xsd" "$OUT/xsd/tap_tsi_b.10.xsd"
  echo "$ERA" > "$OUT/NOTICE"
  "$CLI" index "$OUT/xsd/tap_tsi_b.10.xsd" -o "$OUT/bundle.json"
  entry tap-tsi-b10 "TAP TSI B.10" "Telematics Applications for Passenger services: electronic reservation of assistance for persons with reduced mobility (technical document B.10)" "1.4" \
    "European Union Agency for Railways" "ERA, source acknowledged" "https://www.era.europa.eu/era-folder/tap-baseline-142-archive"
else echo "warning: TAP TSI B.10 schema not downloaded, example left out" >&2; fi

# OASIS UBL 2.4: every document schema of the release (xsd/maindoc) and the common modules.
if fetch https://docs.oasis-open.org/ubl/os-UBL-2.4/UBL-2.4.zip UBL-2.4.zip; then
  start ubl
  TMP=$(mktemp -d)
  unzip -q "$DL/UBL-2.4.zip" -d "$TMP"
  MAINDOC=$(find "$TMP" -type d -path '*/xsd/maindoc' | head -n 1)
  cp -r "$(dirname "$MAINDOC")"/. "$OUT/xsd/"
  rm -rf "$TMP"
  cat > "$OUT/NOTICE" <<'TXT'
Universal Business Language Version 2.4. OASIS Standard, 20 June 2024.
https://docs.oasis-open.org/ubl/os-UBL-2.4/
Copyright (c) OASIS Open 2024. All Rights Reserved.
Distributed under the OASIS Intellectual Property Rights Policy:
https://www.oasis-open.org/policies-guidelines/ipr/
TXT
  "$CLI" index "$OUT/xsd/maindoc" -o "$OUT/bundle.json"
  entry ubl "UBL" "OASIS Universal Business Language: all business document schemas (Invoice, Order, DespatchAdvice, ...) and their common components" "2.4" \
    "OASIS UBL TC" "OASIS IPR Policy" "https://docs.oasis-open.org/ubl/os-UBL-2.4/" "ct/invoice-2:InvoiceType"
else echo "warning: UBL 2.4 not downloaded, example left out" >&2; fi

# W3C XML Schema 1.0 schema for schemas, with the xml: namespace schema it imports.
if fetch https://www.w3.org/2001/XMLSchema.xsd w3c-XMLSchema.xsd && fetch https://www.w3.org/2001/xml.xsd w3c-xml.xsd; then
  start xmlschema
  cp "$DL/w3c-XMLSchema.xsd" "$OUT/xsd/XMLSchema.xsd"
  cp "$DL/w3c-xml.xsd" "$OUT/xsd/xml.xsd"
  cat > "$OUT/NOTICE" <<'TXT'
XML Schema Part 1: Structures / Part 2: Datatypes, schema for schemas.
https://www.w3.org/2001/XMLSchema.xsd and https://www.w3.org/2001/xml.xsd
Copyright (c) World Wide Web Consortium. Used under the W3C Document License:
https://www.w3.org/copyright/document-license-2023/
TXT
  "$CLI" index "$OUT/xsd/XMLSchema.xsd" "$OUT/xsd/xml.xsd" -o "$OUT/bundle.json"
  entry xmlschema "XML Schema (schema for schemas)" "The W3C XML Schema 1.0 definition of XSD itself (XMLSchema.xsd), with xml.xsd" "1.0 (2004)" \
    "W3C" "W3C Document License" "https://www.w3.org/TR/xmlschema-1/" "ct/xs:complexType"
else echo "warning: W3C XMLSchema.xsd not downloaded, example left out" >&2; fi

{
  echo "["
  for i in "${!ENTRIES[@]}"; do
    [ "$i" -gt 0 ] && echo ","
    printf '%s' "${ENTRIES[$i]}"
  done
  echo
  echo "]"
} > "$DIST/examples/examples.json"
echo "examples ready in $DIST/examples"
