//! Embeds the web viewer and the third-party notices in the binary.
//!
//! In the repository they come from `web/dist` (built with `npm run build` in
//! `web/`) and the top-level `THIRD_PARTY_NOTICES.md`. The crate published on
//! crates.io carries copies in `web-dist/` and `THIRD_PARTY_NOTICES.md` next
//! to this file. When the viewer has not been built, a placeholder page is
//! embedded so `cargo build` still works without Node.

use std::fs;
use std::path::{Path, PathBuf};

fn main() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap());

    let web_candidates = [manifest.join("web-dist"), manifest.join("../../web/dist")];
    let web_out = out.join("web");
    let _ = fs::remove_dir_all(&web_out);
    fs::create_dir_all(&web_out).unwrap();
    match web_candidates.iter().find(|d| d.join("index.html").exists()) {
        Some(src) => copy_dir(src, &web_out),
        None => fs::write(
            web_out.join("index.html"),
            "<!doctype html><meta charset=utf-8><title>schema-explorer</title>\
             <p style=\"font-family:sans-serif;margin:3rem\">The viewer was not built into this binary. \
             Run <code>npm ci &amp;&amp; npm run build</code> in <code>web/</code> and rebuild, \
             or use a release build from GitHub.</p>",
        )
        .unwrap(),
    }
    for c in &web_candidates {
        println!("cargo:rerun-if-changed={}", c.display());
    }

    let notice_candidates = [
        manifest.join("THIRD_PARTY_NOTICES.md"),
        manifest.join("../../THIRD_PARTY_NOTICES.md"),
    ];
    let notices = notice_candidates
        .iter()
        .find_map(|p| fs::read_to_string(p).ok())
        .unwrap_or_else(|| "Third-party notices: https://github.com/Matdata-eu/schema-explorer/blob/main/THIRD_PARTY_NOTICES.md\n".to_string());
    fs::write(out.join("THIRD_PARTY_NOTICES.md"), notices).unwrap();
    for c in &notice_candidates {
        println!("cargo:rerun-if-changed={}", c.display());
    }
}

fn copy_dir(src: &Path, dst: &Path) {
    for entry in fs::read_dir(src).unwrap() {
        let entry = entry.unwrap();
        let to = dst.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            fs::create_dir_all(&to).unwrap();
            copy_dir(&entry.path(), &to);
        } else {
            fs::copy(entry.path(), &to).unwrap();
        }
    }
}
