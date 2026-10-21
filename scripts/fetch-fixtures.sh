#!/usr/bin/env bash
# Fetches public real-world schemas for the tests into $SCHEMA_FIXTURES
# (default: tests/fixtures, which is gitignored). Only openly licensed schema
# sets go here; never commit fixtures to the repository.
#   scripts/fetch-fixtures.sh
set -euo pipefail
cd "$(dirname "$0")/.."
DIR="${SCHEMA_FIXTURES:-tests/fixtures}"
mkdir -p "$DIR"
if [ ! -d "$DIR/NeTEx/.git" ]; then
  git clone --depth 1 https://github.com/NeTEx-CEN/NeTEx "$DIR/NeTEx"
else
  git -C "$DIR/NeTEx" pull --ff-only --depth 1
fi
if [ ! -d "$DIR/OSDM/.git" ]; then
  git clone --depth 1 https://github.com/UnionInternationalCheminsdeFer/OSDM "$DIR/OSDM"
else
  git -C "$DIR/OSDM" pull --ff-only --depth 1
fi
echo "fixtures ready in $DIR"
