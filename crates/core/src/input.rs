//! Loading an XSD set from in-memory files: decoding, path handling and
//! resolving `xs:import` / `xs:include` / `xs:redefine` / `xs:override`
//! locations, with an optional callback for files that were not given.

use crate::bundle::{Diagnostic, DirectiveKind, Level};
use std::collections::{HashMap, VecDeque};

pub(crate) const XS: &str = "http://www.w3.org/2001/XMLSchema";
pub(crate) const XML: &str = "http://www.w3.org/XML/1998/namespace";

/// One input file: its name (a path, used to resolve relative schema
/// locations) and its bytes.
#[derive(Debug, Clone)]
pub struct Source {
    pub name: String,
    pub bytes: Vec<u8>,
}

impl Source {
    pub fn new(name: impl Into<String>, bytes: impl Into<Vec<u8>>) -> Source {
        Source {
            name: name.into(),
            bytes: bytes.into(),
        }
    }
}

/// Supplies the bytes of a file that an import or include names but that
/// was not among the inputs; gets the normalized path (or URL).
pub type Resolver<'r> = dyn FnMut(&str) -> Option<Vec<u8>> + 'r;

pub(crate) struct RawDirective {
    pub kind: DirectiveKind,
    pub namespace: Option<String>,
    pub location: Option<String>,
    pub line: u32,
    pub file: Option<usize>,
    pub via: Option<&'static str>,
}

pub(crate) struct LoadedFile {
    /// Normalized path.
    pub name: String,
    /// Path relative to the common directory of all files.
    pub display: String,
    pub text: String,
    pub input: bool,
    pub ok: bool,
    pub target_namespace: Option<String>,
    pub directives: Vec<RawDirective>,
    pub lines: LineIndex,
}

/// Byte offset to line number.
pub(crate) struct LineIndex(Vec<usize>);

impl LineIndex {
    pub fn new(text: &str) -> LineIndex {
        LineIndex(
            text.bytes()
                .enumerate()
                .filter(|(_, b)| *b == b'\n')
                .map(|(i, _)| i)
                .collect(),
        )
    }
    /// 1-based line of byte offset `pos`.
    pub fn line(&self, pos: usize) -> u32 {
        (self.0.partition_point(|&nl| nl < pos) + 1) as u32
    }
}

pub(crate) fn parse_options<'a>() -> roxmltree::ParsingOptions<'a> {
    roxmltree::ParsingOptions {
        allow_dtd: true,
        ..Default::default()
    }
}

/// Decode XML bytes: UTF-8 (with or without BOM), UTF-16 with a BOM, else
/// Latin-1.
pub(crate) fn decode(bytes: &[u8]) -> (String, bool) {
    if let Some(b) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        return (String::from_utf8_lossy(b).into_owned(), true);
    }
    let utf16 = |b: &[u8], le: bool| {
        let units: Vec<u16> = b
            .as_chunks::<2>()
            .0
            .iter()
            .map(|&c| {
                if le {
                    u16::from_le_bytes(c)
                } else {
                    u16::from_be_bytes(c)
                }
            })
            .collect();
        String::from_utf16_lossy(&units)
    };
    if let Some(b) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        return (utf16(b, true), true);
    }
    if let Some(b) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        return (utf16(b, false), true);
    }
    match std::str::from_utf8(bytes) {
        Ok(s) => (s.to_string(), true),
        Err(_) => (bytes.iter().map(|&b| b as char).collect(), false),
    }
}

pub(crate) fn is_url(s: &str) -> bool {
    s.split_once("://")
        .is_some_and(|(scheme, _)| scheme.chars().all(|c| c.is_ascii_alphanumeric()))
}

/// Normalize a path: `\` to `/`, drop `.` segments and fold `..`.
pub fn normalize(path: &str) -> String {
    if is_url(path) {
        return path.to_string();
    }
    let path = path.replace('\\', "/");
    let absolute = path.starts_with('/');
    let mut out: Vec<&str> = Vec::new();
    for seg in path.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                if out.last().is_some_and(|s| *s != "..") {
                    out.pop();
                } else if !absolute {
                    out.push("..");
                }
            }
            s => out.push(s),
        }
    }
    let joined = out.join("/");
    if absolute {
        format!("/{joined}")
    } else {
        joined
    }
}

/// Resolve `location` against the file `base`.
pub fn join(base: &str, location: &str) -> String {
    let location = location.trim();
    if is_url(location) || location.starts_with('/') {
        return normalize(location);
    }
    if is_url(base) {
        let dir = &base[..base.rfind('/').map_or(base.len(), |i| i + 1)];
        return format!("{dir}{location}");
    }
    let dir = match base.rfind(['/', '\\']) {
        Some(i) => &base[..=i],
        None => "",
    };
    normalize(&format!("{dir}{location}"))
}

fn basename(path: &str) -> &str {
    path.rsplit(['/', '\\']).next().unwrap_or(path)
}

fn file_diag(level: Level, code: &str, message: String, file: usize, line: u32) -> Diagnostic {
    Diagnostic {
        level,
        code: code.into(),
        message,
        file: Some(file as u32),
        line,
    }
}

/// Read the root element of one file: target namespace and directives.
fn scan(f: &mut LoadedFile, idx: usize, diags: &mut Vec<Diagnostic>) {
    let doc = match roxmltree::Document::parse_with_options(&f.text, parse_options()) {
        Ok(d) => d,
        Err(e) => {
            let line = e.pos().row;
            diags.push(file_diag(
                Level::Error,
                "parse-error",
                format!("not well-formed XML: {e}"),
                idx,
                line,
            ));
            return;
        }
    };
    let root = doc.root_element();
    if root.tag_name().namespace() != Some(XS) || root.tag_name().name() != "schema" {
        diags.push(file_diag(
            Level::Warning,
            "not-a-schema",
            "the root element is not xs:schema".to_string(),
            idx,
            1,
        ));
        return;
    }
    f.ok = true;
    f.target_namespace = root
        .attribute("targetNamespace")
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    for c in root
        .children()
        .filter(|c| c.tag_name().namespace() == Some(XS))
    {
        let kind = match c.tag_name().name() {
            "import" => DirectiveKind::Import,
            "include" => DirectiveKind::Include,
            "redefine" => DirectiveKind::Redefine,
            "override" => DirectiveKind::Override,
            _ => continue,
        };
        f.directives.push(RawDirective {
            kind,
            namespace: c.attribute("namespace").map(str::to_string),
            location: c
                .attribute("schemaLocation")
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string),
            line: f.lines.line(c.range().start),
            file: None,
            via: None,
        });
    }
}

/// Load the sources and everything they import or include.
pub(crate) fn load(
    sources: Vec<Source>,
    mut resolver: Option<&mut Resolver<'_>>,
    diags: &mut Vec<Diagnostic>,
) -> Vec<LoadedFile> {
    let mut files: Vec<LoadedFile> = Vec::new();
    let mut by_name: HashMap<String, usize> = HashMap::new();
    let add = |files: &mut Vec<LoadedFile>,
               by_name: &mut HashMap<String, usize>,
               diags: &mut Vec<Diagnostic>,
               name: String,
               bytes: &[u8],
               input: bool| {
        let (text, utf8) = decode(bytes);
        let idx = files.len();
        if !utf8 {
            diags.push(file_diag(
                Level::Info,
                "encoding",
                "not UTF-8, read as Latin-1".to_string(),
                idx,
                0,
            ));
        }
        by_name.insert(name.clone(), idx);
        files.push(LoadedFile {
            display: String::new(),
            name,
            lines: LineIndex::new(&text),
            text,
            input,
            ok: false,
            target_namespace: None,
            directives: Vec::new(),
        });
        idx
    };
    for s in sources {
        let name = normalize(&s.name);
        if by_name.contains_key(&name) {
            continue;
        }
        add(&mut files, &mut by_name, diags, name, &s.bytes, true);
    }
    let mut queue: VecDeque<usize> = (0..files.len()).collect();
    while let Some(i) = queue.pop_front() {
        let mut f = std::mem::replace(
            &mut files[i],
            LoadedFile {
                display: String::new(),
                name: String::new(),
                text: String::new(),
                input: false,
                ok: false,
                target_namespace: None,
                directives: Vec::new(),
                lines: LineIndex(Vec::new()),
            },
        );
        scan(&mut f, i, diags);
        for d in &mut f.directives {
            let Some(loc) = &d.location else { continue };
            let target = join(&f.name, loc);
            if let Some(&j) = by_name.get(&target) {
                d.file = Some(j);
                continue;
            }
            if let Some(r) = resolver.as_deref_mut()
                && let Some(bytes) = r(&target)
            {
                let j = add(&mut files, &mut by_name, diags, target, &bytes, false);
                queue.push_back(j);
                d.file = Some(j);
            }
        }
        files[i] = f;
    }
    fallback(&mut files, diags);
    let names: Vec<&str> = files.iter().map(|f| f.name.as_str()).collect();
    let root = common_dir(&names);
    for f in &mut files {
        f.display = f.name.strip_prefix(&root).unwrap_or(&f.name).to_string();
    }
    files
}

/// Resolve the directives whose location was not found: by namespace, by
/// file name, or as the built-in XML namespace; report the rest.
fn fallback(files: &mut [LoadedFile], diags: &mut Vec<Diagnostic>) {
    let mut by_ns: HashMap<&str, Vec<usize>> = HashMap::new();
    let mut by_base: HashMap<&str, Vec<usize>> = HashMap::new();
    for (i, f) in files.iter().enumerate() {
        if let Some(ns) = &f.target_namespace {
            by_ns.entry(ns.as_str()).or_default().push(i);
        }
        by_base.entry(basename(&f.name)).or_default().push(i);
    }
    let mut found: Vec<(usize, usize, Option<usize>, Option<&'static str>)> = Vec::new();
    for (i, f) in files.iter().enumerate() {
        for (k, d) in f.directives.iter().enumerate() {
            if d.file.is_some() {
                continue;
            }
            let ns = d.namespace.as_deref();
            let by_namespace = (d.kind == DirectiveKind::Import)
                .then(|| ns.and_then(|ns| by_ns.get(ns)))
                .flatten()
                .and_then(|v| v.iter().copied().find(|&j| j != i));
            let by_file = d
                .location
                .as_deref()
                .and_then(|l| by_base.get(basename(l)))
                .filter(|v| v.len() == 1)
                .map(|v| v[0])
                .filter(|&j| j != i)
                .filter(|&j| {
                    d.kind != DirectiveKind::Import || files[j].target_namespace.as_deref() == ns
                });
            let r = if let Some(j) = by_namespace {
                (Some(j), Some("namespace"))
            } else if let Some(j) = by_file {
                (Some(j), Some("filename"))
            } else if d.kind == DirectiveKind::Import && ns == Some(XML) {
                (None, Some("builtin"))
            } else if d.kind == DirectiveKind::Import && d.location.is_none() {
                // An import without a location only declares the namespace;
                // components from it show up as unresolved references.
                (None, None)
            } else {
                diags.push(file_diag(
                    Level::Warning,
                    "unresolved-import",
                    format!(
                        "cannot find the {} {}",
                        match d.kind {
                            DirectiveKind::Import => "import",
                            DirectiveKind::Include => "include",
                            DirectiveKind::Redefine => "redefine",
                            DirectiveKind::Override => "override",
                        },
                        d.location.as_deref().or(ns).unwrap_or("?")
                    ),
                    i,
                    d.line,
                ));
                continue;
            };
            found.push((i, k, r.0, r.1));
        }
    }
    for (i, k, file, via) in found {
        let d = &mut files[i].directives[k];
        d.file = file;
        d.via = via;
    }
}

/// The longest common directory of the file names, with a trailing `/`.
pub(crate) fn common_dir(names: &[&str]) -> String {
    let local: Vec<&str> = names.iter().copied().filter(|n| !is_url(n)).collect();
    let Some(first) = local.first() else {
        return String::new();
    };
    let mut prefix: &str = match first.rfind('/') {
        Some(i) => &first[..=i],
        None => return String::new(),
    };
    for n in &local[1..] {
        while !n.starts_with(prefix) {
            prefix = match prefix[..prefix.len() - 1].rfind('/') {
                Some(i) => &prefix[..=i],
                None => return String::new(),
            };
        }
    }
    prefix.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths() {
        assert_eq!(normalize("a/./b/../c.xsd"), "a/c.xsd");
        assert_eq!(normalize("../x.xsd"), "../x.xsd");
        assert_eq!(normalize("/r/a/../../b.xsd"), "/b.xsd");
        assert_eq!(join("a/b/c.xsd", "../../d/e.xsd"), "d/e.xsd");
        assert_eq!(join("c.xsd", "e.xsd"), "e.xsd");
        assert_eq!(join("a\\c.xsd", "e.xsd"), "a/e.xsd");
        assert_eq!(join("a/c.xsd", "http://x.org/y.xsd"), "http://x.org/y.xsd");
        assert_eq!(common_dir(&["/a/b/c.xsd", "/a/b/d/e.xsd"]), "/a/b/");
        assert_eq!(common_dir(&["a.xsd"]), "");
    }

    #[test]
    fn lines() {
        let l = LineIndex::new("a\nb\nc");
        assert_eq!(l.line(0), 1);
        assert_eq!(l.line(2), 2);
        assert_eq!(l.line(4), 3);
    }

    #[test]
    fn decoding() {
        assert_eq!(decode(b"\xEF\xBB\xBFab").0, "ab");
        assert_eq!(decode(b"\xFF\xFEa\0").0, "a");
        assert_eq!(decode(b"\xE9").0, "\u{e9}");
    }
}
