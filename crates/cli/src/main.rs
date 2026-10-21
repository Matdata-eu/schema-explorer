//! Command-line tool of schema-explorer: serves the viewer with local schemas
//! and pre-indexes schema sets into bundles for static hosting.
//!
//! Early development: the commands are stubs.

use std::path::{Path, PathBuf};
use std::time::Instant;

use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand};
use include_dir::{Dir, include_dir};
use schema_explorer_core::bundle::Level;
use schema_explorer_core::{Options, Source};

/// The web viewer, embedded at build time (see build.rs).
static WEB: Dir<'static> = include_dir!("$OUT_DIR/web");
/// The third-party notices, embedded at build time.
static NOTICES: &str = include_str!(concat!(env!("OUT_DIR"), "/THIRD_PARTY_NOTICES.md"));

#[derive(Parser)]
#[command(name = "schema-explorer", version, about)]
struct Cli {
    /// Print the third-party notices and exit.
    #[arg(long)]
    notices: bool,
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Serve the viewer with the given schema files.
    Serve {
        /// Schema files or directories.
        files: Vec<PathBuf>,
        /// Address to listen on.
        #[arg(long, env = "SCHEMA_EXPLORER_BIND", default_value = "127.0.0.1:8080")]
        bind: String,
        /// Do not open a browser.
        #[arg(long, env = "SCHEMA_EXPLORER_NO_OPEN")]
        no_open: bool,
    },
    /// Index schema files into a bundle for the viewer.
    ///
    /// Directories are read recursively (every .xsd file); imports and
    /// includes are followed from disk.
    Index {
        /// Schema files or directories.
        #[arg(required = true)]
        files: Vec<PathBuf>,
        /// Output file.
        #[arg(short, long, default_value = "bundle.json")]
        output: PathBuf,
        /// Write the compact form (no effective content models or search
        /// index; the viewer recomputes them).
        #[arg(long)]
        compact: bool,
        /// Indent the JSON.
        #[arg(long)]
        pretty: bool,
    },
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    if cli.notices {
        print!("{NOTICES}");
        return Ok(());
    }
    match cli.command {
        Some(Command::Serve {
            files,
            bind,
            no_open,
        }) => {
            let _ = (files, no_open);
            bail!(
                "serve is not implemented yet (would listen on {bind}; viewer has {} embedded entries)",
                WEB.entries().len()
            )
        }
        Some(Command::Index {
            files,
            output,
            compact,
            pretty,
        }) => index(&files, &output, compact, pretty),
        None => {
            println!("schema-explorer {}", schema_explorer_core::version());
            Ok(())
        }
    }
}

/// Every .xsd file under `path` (or `path` itself when it is a file).
fn collect(path: &Path, out: &mut Vec<PathBuf>) -> Result<()> {
    if path.is_dir() {
        let mut entries: Vec<PathBuf> = std::fs::read_dir(path)
            .with_context(|| format!("reading {}", path.display()))?
            .map(|e| e.map(|e| e.path()))
            .collect::<std::io::Result<_>>()?;
        entries.sort();
        for p in entries {
            if p.is_dir() || p.extension().is_some_and(|x| x.eq_ignore_ascii_case("xsd")) {
                collect(&p, out)?;
            }
        }
    } else if path.is_file() {
        out.push(path.to_path_buf());
    } else {
        bail!("{} not found", path.display());
    }
    Ok(())
}

fn index(inputs: &[PathBuf], output: &Path, compact: bool, pretty: bool) -> Result<()> {
    let start = Instant::now();
    let mut paths = Vec::new();
    for p in inputs {
        collect(p, &mut paths)?;
    }
    let sources = paths
        .iter()
        .map(|p| {
            let bytes = std::fs::read(p).with_context(|| format!("reading {}", p.display()))?;
            Ok(Source::new(p.to_string_lossy(), bytes))
        })
        .collect::<Result<Vec<_>>>()?;
    let mut resolver = |path: &str| -> Option<Vec<u8>> {
        if path.contains("://") {
            return None;
        }
        std::fs::read(path).ok()
    };
    let opts = Options {
        generator: format!("schema-explorer {}", env!("CARGO_PKG_VERSION")),
        compact,
    };
    let bundle = schema_explorer_core::index(sources, Some(&mut resolver), &opts);
    let json = if pretty {
        schema_explorer_core::to_json_pretty(&bundle)?
    } else {
        schema_explorer_core::to_json(&bundle)?
    };
    std::fs::write(output, &json).with_context(|| format!("writing {}", output.display()))?;
    for d in &bundle.diagnostics {
        if d.level == Level::Info {
            continue;
        }
        let file = d
            .file
            .map_or("", |f| bundle.files[f as usize].name.as_str());
        eprintln!(
            "{:?}: {file}:{}: {} [{}]",
            d.level, d.line, d.message, d.code
        );
    }
    let s = &bundle.stats;
    eprintln!(
        "{} files, {} global and {} local components, {} unresolved imports, {} unresolved references; wrote {} ({} KB) in {:.2?}",
        s.files,
        s.global.values().sum::<u32>(),
        s.local.values().sum::<u32>(),
        s.unresolved_imports,
        s.unresolved_refs,
        output.display(),
        json.len() / 1024,
        start.elapsed()
    );
    Ok(())
}
