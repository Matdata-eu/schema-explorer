//! Tests on real-world schemas.
//!
//! Real schemas are not committed. Tests read them from the directory in the
//! `SCHEMA_FIXTURES` environment variable (default: `tests/fixtures` at the
//! repository root) and are skipped when a schema set is absent. Fetch the
//! public ones with `scripts/fetch-fixtures.sh`.

use std::path::{Path, PathBuf};

fn fixtures_dir() -> PathBuf {
    match std::env::var_os("SCHEMA_FIXTURES") {
        Some(dir) => PathBuf::from(dir),
        None => Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures"),
    }
}

/// The fixture directory `name`, or `None` (with a note) when it is absent.
fn fixture(name: &str) -> Option<PathBuf> {
    let dir = fixtures_dir().join(name);
    if dir.is_dir() {
        Some(dir)
    } else {
        eprintln!("skipping: fixture {} not found", dir.display());
        None
    }
}

fn count_xsd(dir: &Path) -> usize {
    std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| {
            let p = e.path();
            if p.is_dir() {
                count_xsd(&p)
            } else {
                usize::from(p.extension().is_some_and(|x| x == "xsd"))
            }
        })
        .sum()
}

#[test]
fn netex_schemas_are_present() {
    let Some(dir) = fixture("NeTEx") else { return };
    assert!(
        count_xsd(&dir.join("xsd")) > 0,
        "no .xsd files in {}",
        dir.display()
    );
}
