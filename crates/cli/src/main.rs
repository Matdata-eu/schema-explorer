//! Command-line tool of schema-explorer: serves the viewer with local schemas
//! and pre-indexes schema sets into bundles for static hosting.

mod serve;

use std::path::{Path, PathBuf};
use std::time::Instant;

use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand};
use include_dir::{Dir, include_dir};
use schema_explorer_core::bundle::Level;
use schema_explorer_core::{Bundle, Options, Source};

/// The web viewer, embedded at build time (see build.rs).
pub(crate) static WEB: Dir<'static> = include_dir!("$OUT_DIR/web");
/// The third-party notices, embedded at build time.
pub(crate) static NOTICES: &str = include_str!(concat!(env!("OUT_DIR"), "/THIRD_PARTY_NOTICES.md"));

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
    ///
    /// The schemas are indexed once at start; the viewer opens on them and
    /// shows their source. Without files, the viewer opens empty and indexes
    /// what is dropped on it in the browser.
    Serve {
        /// Schema files or directories (every .xsd file in them).
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
    /// Compare two versions of a schema set.
    ///
    /// Each side is a schema file, a directory (every .xsd file in it) or a
    /// bundle made with `index`; join several paths for one side with
    /// commas. Components are matched by qualified name, and by kind and
    /// local name when the target namespace changed between the versions.
    Diff {
        /// The earlier version.
        old: String,
        /// The later version.
        new: String,
        /// Output file (default: standard output).
        #[arg(short, long)]
        output: Option<PathBuf>,
        /// Report format: json (the diff model), md (release notes) or html.
        #[arg(long, value_enum, default_value_t = Format::Json)]
        format: Format,
        /// Match components only by qualified name (no fallback to local
        /// names when the namespace changed).
        #[arg(long)]
        strict_namespaces: bool,
        /// Leave out documentation changes.
        #[arg(long)]
        no_docs: bool,
        /// Titles of the two versions in reports (default: from the schemas' version attributes).
        #[arg(long, num_args = 2, value_names = ["OLD", "NEW"])]
        titles: Option<Vec<String>>,
        /// Exit with status 2 when there are breaking changes.
        #[arg(long)]
        fail_on_breaking: bool,
    },
}

#[derive(Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
enum Format {
    Json,
    Md,
    Html,
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
        }) => serve::run(&files, &bind, no_open),
        Some(Command::Index {
            files,
            output,
            compact,
            pretty,
        }) => index(&files, &output, compact, pretty),
        Some(Command::Diff {
            old,
            new,
            output,
            format,
            strict_namespaces,
            no_docs,
            titles,
            fail_on_breaking,
        }) => {
            let opts = schema_explorer_core::DiffOptions {
                match_local_names: !strict_namespaces,
                docs: !no_docs,
                ..Default::default()
            };
            let breaking = diff(&old, &new, output.as_deref(), format, &opts, titles)?;
            if fail_on_breaking && breaking {
                std::process::exit(2);
            }
            Ok(())
        }
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

/// Read and index the schema files; also returns every file read from disk.
pub(crate) fn build(inputs: &[PathBuf], compact: bool) -> Result<(Bundle, Vec<PathBuf>)> {
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
    let mut read = paths.clone();
    let mut resolver = |path: &str| -> Option<Vec<u8>> {
        if path.contains("://") {
            return None;
        }
        let bytes = std::fs::read(path).ok()?;
        read.push(PathBuf::from(path));
        Some(bytes)
    };
    let opts = Options {
        generator: format!("schema-explorer {}", env!("CARGO_PKG_VERSION")),
        compact,
    };
    let bundle = schema_explorer_core::index(sources, Some(&mut resolver), &opts);
    Ok((bundle, read))
}

/// Print the warnings and errors of a bundle.
pub(crate) fn report(bundle: &Bundle) {
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
}

fn index(inputs: &[PathBuf], output: &Path, compact: bool, pretty: bool) -> Result<()> {
    let start = Instant::now();
    let (bundle, _) = build(inputs, compact)?;
    let json = if pretty {
        schema_explorer_core::to_json_pretty(&bundle)?
    } else {
        schema_explorer_core::to_json(&bundle)?
    };
    std::fs::write(output, &json).with_context(|| format!("writing {}", output.display()))?;
    report(&bundle);
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

/// Load one side of a comparison: a bundle (.json) or schema paths.
fn load_side(spec: &str) -> Result<Bundle> {
    let paths: Vec<PathBuf> = spec
        .split(',')
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .collect();
    if let [p] = paths.as_slice()
        && p.is_file()
        && p.extension()
            .is_some_and(|x| x.eq_ignore_ascii_case("json"))
    {
        let text =
            std::fs::read_to_string(p).with_context(|| format!("reading {}", p.display()))?;
        let mut b: Bundle = serde_json::from_str(&text)
            .with_context(|| format!("{} is not a schema-explorer bundle", p.display()))?;
        schema_explorer_core::expand(&mut b);
        return Ok(b);
    }
    let (b, _) = build(&paths, false)?;
    report(&b);
    Ok(b)
}

/// Compare two schema sets; true when there are breaking changes.
fn diff(
    old: &str,
    new: &str,
    output: Option<&Path>,
    format: Format,
    opts: &schema_explorer_core::DiffOptions,
    titles: Option<Vec<String>>,
) -> Result<bool> {
    let start = Instant::now();
    let a = load_side(old)?;
    let b = load_side(new)?;
    let mut d = schema_explorer_core::diff(&a, &b, opts);
    d.generator = format!("schema-explorer {}", env!("CARGO_PKG_VERSION"));
    if let Some(t) = titles {
        d.old.title = t.first().cloned();
        d.new.title = t.get(1).cloned();
    }
    let text = match format {
        Format::Json => serde_json::to_string_pretty(&d)?,
        Format::Md => schema_explorer_core::report::markdown(&d),
        Format::Html => schema_explorer_core::report::html(&d),
    };
    match output {
        Some(p) => std::fs::write(p, &text).with_context(|| format!("writing {}", p.display()))?,
        None => println!("{text}"),
    }
    let t = &d.summary.total;
    eprintln!(
        "{} added, {} removed, {} changed ({} breaking, {} documentation only), {} possibly renamed; {} breaking changes in all, in {:.2?}",
        t.added,
        t.removed,
        t.changed,
        t.breaking,
        t.docs_only,
        d.summary.possibly_renamed,
        d.summary.breaking_changes,
        start.elapsed()
    );
    Ok(t.breaking > 0)
}
