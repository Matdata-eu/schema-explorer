#!/usr/bin/env bash
# Sets the version of every crate and of the npm package, e.g. from a release tag:
#   scripts/set-version.sh 1.2.0
set -euo pipefail
V="${1#v}"
cd "$(dirname "$0")/.."
# [workspace.package] version and the path dependencies on the core crate.
sed -i.bak -E "s/^version = \"[^\"]+\"/version = \"${V}\"/" Cargo.toml
sed -i.bak -E "s/(schema-explorer-core = \{ path = \"[^\"]+\", version = \")[^\"]+\"/\1${V}\"/" Cargo.toml crates/wasm/Cargo.toml
rm -f Cargo.toml.bak crates/wasm/Cargo.toml.bak
cargo update --workspace --offline >/dev/null 2>&1 || cargo update --workspace
(cd web && npm version "$V" --no-git-tag-version --allow-same-version >/dev/null)
echo "version set to ${V}"
