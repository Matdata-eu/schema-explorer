#!/usr/bin/env bash
# Builds the examples catalog of the Pages site into <dist>/examples/:
# a pre-indexed bundle per schema set, its .xsd files (for the source view)
# and examples.json, which the open page lists.
#
# Only freely redistributable schema sets go here. NeTEx (GPL-3.0) is fetched
# from its public repository at build time. Never add railML (CC BY-NC-ND) or
# other schemas whose licence forbids redistribution.
#
#   scripts/build-examples.sh <schema-explorer binary> <dist dir>
set -euo pipefail
CLI=$(realpath "$1")
DIST=$(realpath "$2")
cd "$(dirname "$0")/.."
WORK="${SCHEMA_FIXTURES:-tests/fixtures}"
mkdir -p "$WORK" "$DIST/examples"

if [ ! -d "$WORK/NeTEx/.git" ]; then
  git clone --depth 1 https://github.com/NeTEx-CEN/NeTEx "$WORK/NeTEx"
fi
NETEX_REV=$(git -C "$WORK/NeTEx" rev-parse --short HEAD)
OUT="$DIST/examples/netex"
rm -rf "$OUT"
mkdir -p "$OUT"
cp -r "$WORK/NeTEx/xsd" "$OUT/xsd"
cp "$WORK/NeTEx/LICENSE" "$OUT/LICENSE"
"$CLI" index "$OUT/xsd/NeTEx_publication.xsd" -o "$OUT/bundle.json"

cat > "$DIST/examples/examples.json" <<JSON
[
  {
    "id": "netex",
    "title": "NeTEx",
    "description": "Network Timetable Exchange, the CEN standard for public transport data (NeTEx_publication.xsd, revision $NETEX_REV)",
    "publisher": "CEN TC278 · NeTEx-CEN",
    "licence": "GPL-3.0",
    "src": "netex/bundle.json",
    "sources": "netex/xsd/",
    "focus": "ct/netex:StopPlace_VersionStructure"
  }
]
JSON
echo "examples ready in $DIST/examples"
