//! `serve`: the embedded viewer in a local web server, with the bundle of
//! the schemas given on the command line and their source files.

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};
use axum::{
    Router,
    extract::{Path, State},
    http::{HeaderValue, StatusCode, Uri, header},
    response::{IntoResponse, Response},
    routing::get,
};

use crate::{NOTICES, WEB};

/// What the server hands out.
struct Loaded {
    /// The bundle as JSON, when schemas were given.
    bundle: Option<String>,
    /// The file on disk behind each file of the bundle.
    files: Vec<Option<PathBuf>>,
    title: Option<String>,
}

pub fn run(inputs: &[PathBuf], bind: &str, no_open: bool) -> Result<()> {
    let loaded = if inputs.is_empty() {
        Loaded {
            bundle: None,
            files: Vec::new(),
            title: None,
        }
    } else {
        let started = std::time::Instant::now();
        let (bundle, read) = crate::build(inputs, false)?;
        crate::report(&bundle);
        let files = bundle
            .files
            .iter()
            .map(|f| match_file(&f.name, &read))
            .collect();
        let title = (inputs.len() == 1).then(|| {
            inputs[0]
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default()
        });
        let json = schema_explorer_core::to_json(&bundle)?;
        eprintln!(
            "indexed {} files ({} components) in {:.2?}",
            bundle.files.len(),
            bundle.components.len(),
            started.elapsed()
        );
        Loaded {
            bundle: Some(json),
            files,
            title,
        }
    };
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    rt.block_on(serve(Arc::new(loaded), bind, no_open))
}

/// The path read from disk whose name ends with the bundle's (relative) file name.
fn match_file(name: &str, read: &[PathBuf]) -> Option<PathBuf> {
    let want = name.replace('\\', "/");
    read.iter()
        .find(|p| {
            let s = p.to_string_lossy().replace('\\', "/");
            s == want || s.ends_with(&format!("/{want}"))
        })
        .cloned()
}

async fn serve(state: Arc<Loaded>, bind: &str, no_open: bool) -> Result<()> {
    let app = Router::new()
        .route("/api/status", get(status))
        .route("/api/bundle", get(bundle))
        .route("/api/source/{file}", get(source))
        .route("/licenses", get(licenses))
        .fallback(get(static_file))
        .with_state(state);
    let listener = tokio::net::TcpListener::bind(bind)
        .await
        .with_context(|| format!("cannot listen on {bind}"))?;
    let url = format!("http://{}/", listener.local_addr()?);
    eprintln!("schema-explorer listening on {url}  (Ctrl+C to stop)");
    if !no_open && webbrowser::open(&url).is_err() {
        eprintln!("open {url} in your browser");
    }
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}

async fn status(State(s): State<Arc<Loaded>>) -> Response {
    let body = serde_json::json!({
        "server": true,
        "version": env!("CARGO_PKG_VERSION"),
        "loaded": s.bundle.is_some(),
        "title": s.title,
    });
    with_type(
        body.to_string().into_response(),
        "application/json",
        "no-store",
    )
}

async fn bundle(State(s): State<Arc<Loaded>>) -> Response {
    match &s.bundle {
        Some(json) => with_type(json.clone().into_response(), "application/json", "no-store"),
        None => (StatusCode::NOT_FOUND, "no schemas loaded").into_response(),
    }
}

/// The text of one schema file of the bundle, for the viewer's source view.
async fn source(State(s): State<Arc<Loaded>>, Path(file): Path<usize>) -> Response {
    let Some(Some(path)) = s.files.get(file) else {
        return (StatusCode::NOT_FOUND, "no such file").into_response();
    };
    match tokio::fs::read(path).await {
        Ok(bytes) => with_type(bytes.into_response(), "application/xml", "no-cache"),
        Err(e) => (StatusCode::NOT_FOUND, e.to_string()).into_response(),
    }
}

async fn licenses() -> Response {
    with_type(
        NOTICES.into_response(),
        "text/plain; charset=utf-8",
        "no-cache",
    )
}

fn with_type(mut r: Response, mime: &'static str, cache: &'static str) -> Response {
    r.headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(mime));
    r.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    r
}

async fn static_file(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };
    let Some(file) = WEB.get_file(path) else {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    };
    let mime = match path.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript",
        "css" => "text/css",
        "json" => "application/json",
        "wasm" => "application/wasm",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "woff2" => "font/woff2",
        "txt" | "md" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    };
    let cache = if path.starts_with("assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    with_type(file.contents().into_response(), mime, cache)
}
