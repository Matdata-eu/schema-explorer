//! Command-line tool of schema-explorer: serves the viewer with local schemas
//! and pre-indexes schema sets into bundles for static hosting.
//!
//! Early development: the commands are stubs.

use std::path::PathBuf;

use anyhow::{Result, bail};
use clap::{Parser, Subcommand};
use include_dir::{Dir, include_dir};

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
    Index {
        /// Schema files or directories.
        files: Vec<PathBuf>,
        /// Output file.
        #[arg(short, long, default_value = "bundle.json")]
        output: PathBuf,
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
        Some(Command::Index { files, output }) => {
            let _ = files;
            bail!(
                "index is not implemented yet (would write {})",
                output.display()
            )
        }
        None => {
            println!("schema-explorer {}", schema_explorer_core::version());
            Ok(())
        }
    }
}
