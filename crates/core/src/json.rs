//! JSON Schema input: draft-04, -06, -07, 2019-09 and 2020-12 (picked by
//! `$schema`, 2020-12 by default), and the schemas of OpenAPI 3.x and
//! AsyncAPI 2/3 documents, in JSON or YAML.
//!
//! The schemas are mapped onto the XSD model so that the viewer, search,
//! where-used and the version comparison work unchanged: named schemas
//! (`$defs`, `definitions`, `components.schemas`, message payloads, the root
//! schema of a file and every other `$ref` target) become global complex or
//! simple types; object properties become local elements with a cardinality
//! from `required` and `minItems`/`maxItems`; a `$ref` in `allOf` is the base
//! type (extension); `oneOf`/`anyOf` are choices (or unions of simple
//! types); `enum`/`const` are enumerations and the validation keywords are
//! facets. [`JsonInfo`] keeps what each component is in JSON terms.

use crate::bundle::*;
use crate::input::{self, Resolver, Source};
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet, VecDeque};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Flavor {
    Schema,
    OpenApi,
    AsyncApi,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Draft {
    D4,
    D6,
    D7,
    D2019,
    D2020,
}

pub(crate) struct JDoc {
    pub name: String,
    pub display: String,
    pub input: bool,
    pub value: Option<Value>,
    flavor: Flavor,
    draft: Draft,
    /// `JSON Schema 2020-12`, `OpenAPI 3.1.0`, ...
    pub label: String,
    /// Other files named by a `$ref`: location and the file it was found as.
    pub refs: Vec<(String, Option<usize>)>,
}

/// A file name that the JSON reader takes: `.json`, `.yaml`, `.yml`.
pub fn is_json_name(name: &str) -> bool {
    let l = name.to_ascii_lowercase();
    l.ends_with(".json") || l.ends_with(".yaml") || l.ends_with(".yml")
}

/// Keywords whose values are data, not schemas: never searched for `$ref`,
/// `$id` or `$defs`.
const DATA: &[&str] = &["enum", "const", "default", "examples", "example"];

/// Keywords that only annotate: a `$ref` next to them is still a plain reference.
const ANNOTATIONS: &[&str] = &[
    "description",
    "title",
    "$comment",
    "examples",
    "example",
    "deprecated",
    "readOnly",
    "writeOnly",
    "default",
    "nullable",
    "$id",
    "$schema",
    "$anchor",
    "id",
    "externalDocs",
    "xml",
];

fn is_annotation(k: &str) -> bool {
    ANNOTATIONS.contains(&k) || k.starts_with("x-")
}

/// Keywords that make a schema an object or array (a complex type).
const STRUCTURAL: &[&str] = &[
    "properties",
    "patternProperties",
    "additionalProperties",
    "unevaluatedProperties",
    "items",
    "prefixItems",
    "additionalItems",
    "required",
    "minProperties",
    "maxProperties",
    "dependentSchemas",
    "propertyNames",
    "discriminator",
];

fn parse(name: &str, bytes: &[u8]) -> Result<Value, (String, u32)> {
    let (text, _) = input::decode(bytes);
    let t = text.trim_start_matches('\u{feff}');
    let l = name.to_ascii_lowercase();
    let yaml = l.ends_with(".yaml") || l.ends_with(".yml");
    if !yaml || t.trim_start().starts_with('{') {
        match serde_json::from_str::<Value>(t) {
            Ok(v) => return Ok(v),
            Err(e) if !yaml => return Err((e.to_string(), e.line() as u32)),
            Err(_) => {}
        }
    }
    let mut y: serde_yaml_ng::Value = serde_yaml_ng::from_str(t).map_err(|e| {
        let line = e.location().map_or(0, |l| l.line() as u32);
        (e.to_string(), line)
    })?;
    y.apply_merge().map_err(|e| (e.to_string(), 0))?;
    Ok(from_yaml(y))
}

fn from_yaml(y: serde_yaml_ng::Value) -> Value {
    use serde_yaml_ng::Value as Y;
    match y {
        Y::Null => Value::Null,
        Y::Bool(b) => Value::Bool(b),
        Y::Number(n) => {
            if let Some(i) = n.as_i64() {
                Value::from(i)
            } else if let Some(u) = n.as_u64() {
                Value::from(u)
            } else {
                n.as_f64()
                    .and_then(serde_json::Number::from_f64)
                    .map_or(Value::Null, Value::Number)
            }
        }
        Y::String(s) => Value::String(s),
        Y::Sequence(s) => Value::Array(s.into_iter().map(from_yaml).collect()),
        Y::Mapping(m) => Value::Object(
            m.into_iter()
                .map(|(k, v)| {
                    let k = match k {
                        Y::String(s) => s,
                        Y::Bool(b) => b.to_string(),
                        Y::Number(n) => n.to_string(),
                        Y::Null => "null".to_string(),
                        other => serde_yaml_ng::to_string(&other)
                            .unwrap_or_default()
                            .trim()
                            .to_string(),
                    };
                    (k, from_yaml(v))
                })
                .collect(),
        ),
        Y::Tagged(t) => from_yaml(t.value),
    }
}

fn detect(v: &Value) -> (Flavor, Draft, String) {
    let s = |k: &str| v.get(k).and_then(Value::as_str);
    if let Some(ver) = s("openapi") {
        let d = if ver.starts_with("3.0") {
            Draft::D4
        } else {
            Draft::D2020
        };
        return (Flavor::OpenApi, d, format!("OpenAPI {ver}"));
    }
    if let Some(ver) = s("asyncapi") {
        return (Flavor::AsyncApi, Draft::D7, format!("AsyncAPI {ver}"));
    }
    if let Some(ver) = s("swagger") {
        return (Flavor::Schema, Draft::D4, format!("Swagger {ver}"));
    }
    let d = match s("$schema") {
        Some(u) if u.contains("draft-04") || u.contains("draft-03") => Draft::D4,
        Some(u) if u.contains("draft-06") => Draft::D6,
        Some(u) if u.contains("draft-07") => Draft::D7,
        Some(u) if u.contains("2019-09") => Draft::D2019,
        _ => Draft::D2020,
    };
    let name = match d {
        Draft::D4 => "draft-04",
        Draft::D6 => "draft-06",
        Draft::D7 => "draft-07",
        Draft::D2019 => "2019-09",
        Draft::D2020 => "2020-12",
    };
    (Flavor::Schema, d, format!("JSON Schema {name}"))
}

fn escape(seg: &str) -> String {
    seg.replace('~', "~0").replace('/', "~1")
}

fn unescape(seg: &str) -> String {
    seg.replace("~1", "/").replace("~0", "~")
}

fn child(ptr: &str, seg: &str) -> String {
    format!("{ptr}/{}", escape(seg))
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let hex = |c: u8| (c as char).to_digit(16);
        if b[i] == b'%'
            && i + 2 < b.len()
            && let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2]))
        {
            out.push((h * 16 + l) as u8);
            i += 3;
            continue;
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn split_frag(r: &str) -> (&str, Option<&str>) {
    match r.split_once('#') {
        Some((u, f)) => (u, Some(f)),
        None => (r, None),
    }
}

/// A URI with a scheme (`https:`, `urn:`, ...).
fn has_scheme(s: &str) -> bool {
    match s.find(':') {
        Some(i) if i > 1 => s[..i]
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.')),
        _ => false,
    }
}

fn dot_segments(path: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    for seg in path.split('/') {
        match seg {
            "." => {}
            ".." => {
                if out.len() > 1 {
                    out.pop();
                }
            }
            s => out.push(s),
        }
    }
    out.join("/")
}

/// Resolve `rel` against the base URI or file path `base`.
fn resolve_uri(base: &str, rel: &str) -> String {
    if rel.is_empty() {
        return base.to_string();
    }
    if has_scheme(rel) {
        return rel.to_string();
    }
    if input::is_url(base) {
        let start = base.find("://").map_or(0, |i| i + 3);
        let host_end = base[start..].find('/').map_or(base.len(), |i| start + i);
        if rel.starts_with('/') {
            return format!("{}{}", &base[..host_end], dot_segments(rel));
        }
        let dir = &base[..base
            .rfind('/')
            .filter(|&i| i >= host_end)
            .map_or(base.len(), |i| i + 1)];
        let path = format!("{}{rel}", &dir[host_end..]);
        let path = if path.starts_with('/') {
            path
        } else {
            format!("/{path}")
        };
        return format!("{}{}", &base[..host_end], dot_segments(&path));
    }
    if has_scheme(base) {
        return rel.to_string();
    }
    input::join(base, rel)
}

/// Every `$ref` string in `v` (not in data keywords), with the pointer of
/// the object that holds it.
fn refs<'v>(v: &'v Value, ptr: &str, out: &mut Vec<(String, &'v str)>) {
    match v {
        Value::Object(m) => {
            if let Some(Value::String(r)) = refkw(m) {
                out.push((ptr.to_string(), r));
            }
            for (k, c) in m {
                if !DATA.contains(&k.as_str()) && (c.is_object() || c.is_array()) {
                    refs(c, &child(ptr, k), out);
                }
            }
        }
        Value::Array(a) => {
            for (i, c) in a.iter().enumerate() {
                refs(c, &child(ptr, &i.to_string()), out);
            }
        }
        _ => {}
    }
}

pub(crate) fn load(
    sources: Vec<Source>,
    mut resolver: Option<&mut Resolver<'_>>,
    diags: &mut Vec<Diagnostic>,
) -> Vec<JDoc> {
    let mut docs: Vec<JDoc> = Vec::new();
    let mut by_name: HashMap<String, usize> = HashMap::new();
    let add = |docs: &mut Vec<JDoc>,
               by_name: &mut HashMap<String, usize>,
               diags: &mut Vec<Diagnostic>,
               name: String,
               bytes: &[u8],
               input: bool| {
        let idx = docs.len();
        let value = match parse(&name, bytes) {
            Ok(v) => Some(v),
            Err((msg, line)) => {
                diags.push(Diagnostic {
                    level: Level::Error,
                    code: "parse-error".into(),
                    message: msg,
                    file: Some(idx as FileId),
                    line,
                });
                None
            }
        };
        let (flavor, draft, label) = value
            .as_ref()
            .map_or_else(|| (Flavor::Schema, Draft::D2020, String::new()), detect);
        by_name.insert(name.clone(), idx);
        docs.push(JDoc {
            name,
            display: String::new(),
            input,
            value,
            flavor,
            draft,
            label,
            refs: Vec::new(),
        });
        idx
    };
    for s in sources {
        let name = input::normalize(&s.name);
        if by_name.contains_key(&name) {
            continue;
        }
        add(&mut docs, &mut by_name, diags, name, &s.bytes, true);
    }
    let mut queue: VecDeque<usize> = (0..docs.len()).collect();
    while let Some(i) = queue.pop_front() {
        let Some(v) = &docs[i].value else { continue };
        let mut found = Vec::new();
        refs(v, "", &mut found);
        let mut locations: Vec<String> = Vec::new();
        for (_, r) in found {
            let (u, _) = split_frag(r);
            if !u.is_empty() && !locations.iter().any(|l| l == u) {
                locations.push(u.to_string());
            }
        }
        let mut out = Vec::new();
        for loc in locations {
            let target = if has_scheme(&loc) {
                loc.clone()
            } else {
                input::join(&docs[i].name, &loc)
            };
            let mut file = by_name.get(&target).copied();
            if file.is_none()
                && let Some(r) = resolver.as_deref_mut()
                && let Some(bytes) = r(&target)
            {
                let j = add(&mut docs, &mut by_name, diags, target, &bytes, false);
                // A fragment file without `$schema` takes the dialect of
                // the document that refers to it (OpenAPI 3.0, ...).
                if docs[j].flavor == Flavor::Schema
                    && docs[j]
                        .value
                        .as_ref()
                        .is_some_and(|v| v.get("$schema").is_none() && v.get("swagger").is_none())
                {
                    docs[j].draft = docs[i].draft;
                    docs[j].label = docs[i].label.clone();
                }
                queue.push_back(j);
                file = Some(j);
            }
            out.push((loc, file));
        }
        docs[i].refs = out;
    }
    let names: Vec<&str> = docs.iter().map(|f| f.name.as_str()).collect();
    let root = input::common_dir(&names);
    for f in &mut docs {
        f.display = f.name.strip_prefix(&root).unwrap_or(&f.name).to_string();
    }
    docs
}

/// `$id`s and anchors of all files.
#[derive(Default)]
struct Registry {
    /// Absolute URI (or file name) of a schema resource to its location.
    resources: HashMap<String, (usize, String)>,
    /// `uri#anchor` to its location.
    anchors: HashMap<String, (usize, String)>,
    /// The base URI of the objects that set one with `$id`.
    bases: HashMap<(usize, String), String>,
}

impl Registry {
    fn new(docs: &[JDoc]) -> Registry {
        let mut reg = Registry::default();
        for (d, doc) in docs.iter().enumerate() {
            reg.resources
                .entry(doc.name.clone())
                .or_insert((d, String::new()));
            if let Some(v) = &doc.value {
                reg.walk(d, v, "", &doc.name, doc.draft);
            }
        }
        reg
    }

    fn walk(&mut self, d: usize, v: &Value, ptr: &str, base: &str, draft: Draft) {
        match v {
            Value::Object(m) => {
                let mut base = base.to_string();
                let id = m.get("$id").or(if draft == Draft::D4 {
                    m.get("id")
                } else {
                    None
                });
                if let Some(Value::String(id)) = id {
                    let (u, frag) = split_frag(id);
                    if !u.is_empty() {
                        base = resolve_uri(&base, u);
                        self.resources
                            .entry(base.clone())
                            .or_insert((d, ptr.to_string()));
                        self.bases.insert((d, ptr.to_string()), base.clone());
                    }
                    if let Some(f) = frag.filter(|f| !f.is_empty()) {
                        self.anchors
                            .insert(format!("{base}#{f}"), (d, ptr.to_string()));
                    }
                }
                for k in ["$anchor", "$dynamicAnchor"] {
                    if let Some(Value::String(a)) = m.get(k) {
                        self.anchors
                            .entry(format!("{base}#{a}"))
                            .or_insert((d, ptr.to_string()));
                    }
                }
                for (k, c) in m {
                    if !DATA.contains(&k.as_str()) && (c.is_object() || c.is_array()) {
                        self.walk(d, c, &child(ptr, k), &base, draft);
                    }
                }
            }
            Value::Array(a) => {
                for (i, c) in a.iter().enumerate() {
                    self.walk(d, c, &child(ptr, &i.to_string()), base, draft);
                }
            }
            _ => {}
        }
    }

    fn base_of(&self, docs: &[JDoc], d: usize, ptr: &str) -> String {
        let mut p = ptr;
        loop {
            if let Some(b) = self.bases.get(&(d, p.to_string())) {
                return b.clone();
            }
            if p.is_empty() {
                return docs[d].name.clone();
            }
            p = &p[..p.rfind('/').unwrap_or(0)];
        }
    }

    /// The location a `$ref` in the object at `ptr` of file `d` points to.
    fn resolve(&self, docs: &[JDoc], d: usize, ptr: &str, r: &str) -> Option<(usize, String)> {
        let base = self.base_of(docs, d, ptr);
        let (u, frag) = split_frag(r);
        let root = if u.is_empty() {
            self.resources
                .get(&base)
                .cloned()
                .unwrap_or((d, String::new()))
        } else {
            let abs = resolve_uri(&base, u);
            self.resources
                .get(&abs)
                .or_else(|| self.resources.get(&input::join(&docs[d].name, u)))
                .cloned()?
        };
        let frag = percent_decode(frag.unwrap_or(""));
        let loc = if frag.is_empty() {
            root
        } else if frag.starts_with('/') {
            (root.0, format!("{}{frag}", root.1))
        } else {
            let b = self.base_of(docs, root.0, &root.1);
            self.anchors.get(&format!("{b}#{frag}")).cloned()?
        };
        docs[loc.0].value.as_ref()?.pointer(&loc.1)?;
        Some(loc)
    }
}

fn stem(name: &str) -> String {
    let base = name.rsplit('/').next().unwrap_or(name);
    let mut s = base;
    for ext in [".json", ".yaml", ".yml"] {
        if s.len() > ext.len() && s[s.len() - ext.len()..].eq_ignore_ascii_case(ext) {
            s = &s[..s.len() - ext.len()];
            break;
        }
    }
    s.strip_suffix(".schema").unwrap_or(s).to_string()
}

const KEYWORD_SEGMENTS: &[&str] = &[
    "schema",
    "items",
    "additionalProperties",
    "payload",
    "content",
    "properties",
    "allOf",
    "anyOf",
    "oneOf",
    "not",
    "$defs",
    "definitions",
    "patternProperties",
    "prefixItems",
    "schemas",
    "components",
];

/// A name for the schema at `ptr` that is not a named definition.
fn name_hint(ptr: &str) -> Option<String> {
    let segs: Vec<String> = ptr.split('/').skip(1).map(unescape).collect();
    segs.into_iter().rev().find(|s| {
        !s.is_empty()
            && !s.contains('/')
            && !s.chars().all(|c| c.is_ascii_digit())
            && !KEYWORD_SEGMENTS.contains(&s.as_str())
    })
}

fn text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

fn types(m: &Map<String, Value>) -> Vec<String> {
    match m.get("type") {
        Some(Value::String(t)) => vec![t.clone()],
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    }
}

const REF_KEYWORDS: &[&str] = &["$ref", "$dynamicRef", "$recursiveRef"];

/// The `$ref` of a schema, or its `$dynamicRef` / `$recursiveRef` (taken
/// as a plain reference to the anchor or resource it names).
fn refkw(m: &Map<String, Value>) -> Option<&Value> {
    REF_KEYWORDS.iter().find_map(|k| m.get(*k))
}

fn is_ref_only(m: &Map<String, Value>) -> bool {
    refkw(m).is_some()
        && m.keys()
            .all(|k| REF_KEYWORDS.contains(&k.as_str()) || is_annotation(k))
}

/// A schema that only names a JSON type: `{"type": "string"}`.
fn plain_type(m: &Map<String, Value>) -> Option<String> {
    if !m.keys().all(|k| k == "type" || is_annotation(k))
        || m.get("nullable") == Some(&Value::Bool(true))
    {
        return None;
    }
    match m.get("type") {
        None => Some("any".into()),
        Some(Value::String(t)) => Some(t.clone()),
        _ => None,
    }
}

fn is_array_schema(m: &Map<String, Value>) -> bool {
    let t = types(m);
    t.iter().any(|t| t == "array")
        || (t.is_empty() && (m.contains_key("items") || m.contains_key("prefixItems")))
}

/// What a complex type is: `object`, `array`, `oneOf`, `anyOf`.
fn shape(m: &Map<String, Value>) -> &'static str {
    let t = types(m);
    if t.iter().any(|t| t == "object") || m.contains_key("properties") {
        "object"
    } else if is_array_schema(m) {
        "array"
    } else if m.contains_key("oneOf") {
        "oneOf"
    } else if m.contains_key("anyOf") {
        "anyOf"
    } else {
        "object"
    }
}

fn facets(m: &Map<String, Value>, draft: Draft) -> Vec<Facet> {
    let mut out = Vec::new();
    let f = |kind: &str, value: String| Facet {
        kind: kind.to_string(),
        value,
        fixed: false,
    };
    let excl = |k: &str| draft == Draft::D4 && m.get(k) == Some(&Value::Bool(true));
    for k in [
        "format",
        "pattern",
        "minLength",
        "maxLength",
        "minimum",
        "maximum",
        "exclusiveMinimum",
        "exclusiveMaximum",
        "multipleOf",
        "minItems",
        "maxItems",
        "uniqueItems",
        "minContains",
        "maxContains",
        "minProperties",
        "maxProperties",
        "contentEncoding",
        "contentMediaType",
    ] {
        let Some(v) = m.get(k) else { continue };
        match (k, v) {
            ("exclusiveMinimum" | "exclusiveMaximum" | "uniqueItems", Value::Bool(_)) => {
                if k == "uniqueItems" && v == &Value::Bool(true) {
                    out.push(f(k, "true".into()));
                }
            }
            ("minimum", _) if excl("exclusiveMinimum") => out.push(f("exclusiveMinimum", text(v))),
            ("maximum", _) if excl("exclusiveMaximum") => out.push(f("exclusiveMaximum", text(v))),
            _ => out.push(f(k, text(v))),
        }
    }
    if m.get("nullable") == Some(&Value::Bool(true))
        || types(m).iter().any(|t| t == "null") && types(m).len() > 1
    {
        out.push(f("nullable", "true".into()));
    }
    out
}

fn enumerations(m: &Map<String, Value>) -> Vec<Enumeration> {
    let mut out = Vec::new();
    let descs = m
        .get("x-enum-descriptions")
        .or_else(|| m.get("x-enumDescriptions"));
    if let Some(Value::Array(vals)) = m.get("enum") {
        for (i, v) in vals.iter().enumerate() {
            let value = text(v);
            let doc = match descs {
                Some(Value::Array(a)) => a.get(i).and_then(Value::as_str),
                Some(Value::Object(o)) => o.get(&value).and_then(Value::as_str),
                _ => None,
            };
            out.push(Enumeration {
                value,
                docs: doc
                    .map(|t| Doc {
                        lang: None,
                        source: None,
                        text: t.to_string(),
                    })
                    .into_iter()
                    .collect(),
                appinfo: Vec::new(),
                line: 0,
            });
        }
    }
    if let Some(v) = m.get("const") {
        out.push(Enumeration {
            value: text(v),
            docs: Vec::new(),
            appinfo: Vec::new(),
            line: 0,
        });
    }
    out
}

fn doc(text: &str) -> Doc {
    Doc {
        lang: None,
        source: None,
        text: text.to_string(),
    }
}

/// What the properties of an object and its inline `allOf` parts add up to.
#[derive(Default)]
struct Parts {
    base: Option<Ref>,
    mixins: Vec<Id>,
    props: Vec<(String, String)>,
    required: Vec<String>,
    pattern: Vec<(String, String)>,
    additional: Option<String>,
    open: Option<bool>,
    closed_unevaluated: bool,
    choices: Vec<(bool, String)>,
    facets: Vec<Facet>,
    enums: Vec<Enumeration>,
}

pub(crate) struct Builder<'a> {
    docs: &'a [JDoc],
    reg: Registry,
    pub components: Vec<Component>,
    pub usages: Vec<(Id, Usage)>,
    pub diagnostics: Vec<Diagnostic>,
    pub namespaces: Vec<Namespace>,
    pub file_ns: Vec<Option<NsId>>,
    pub file_globals: Vec<u32>,
    pub unresolved_refs: u32,
    globals: HashMap<(usize, String), Id>,
    taken: HashSet<(Option<NsId>, String)>,
    builtins: HashMap<String, Id>,
    queue: VecDeque<(Id, usize, String)>,
    simple_memo: HashMap<(usize, String), bool>,
    mixins: Vec<(Id, Id)>,
}

impl<'a> Builder<'a> {
    pub fn new(docs: &'a [JDoc]) -> Builder<'a> {
        Builder {
            docs,
            reg: Registry::new(docs),
            components: Vec::new(),
            usages: Vec::new(),
            diagnostics: Vec::new(),
            namespaces: Vec::new(),
            file_ns: vec![None; docs.len()],
            file_globals: vec![0; docs.len()],
            unresolved_refs: 0,
            globals: HashMap::new(),
            taken: HashSet::new(),
            builtins: HashMap::new(),
            queue: VecDeque::new(),
            simple_memo: HashMap::new(),
            mixins: Vec::new(),
        }
    }

    fn value(&self, d: usize, ptr: &str) -> Option<&'a Value> {
        self.docs[d].value.as_ref()?.pointer(ptr)
    }

    /// The named schemas of a file: pointer and name.
    fn entries(&self, d: usize) -> Vec<(String, String)> {
        let doc = &self.docs[d];
        let Some(v) = &doc.value else {
            return Vec::new();
        };
        let mut out = Vec::new();
        let map = |ptr: String, out: &mut Vec<(String, String)>| {
            if let Some(Value::Object(m)) = v.pointer(&ptr) {
                for k in m.keys() {
                    out.push((child(&ptr, k), k.clone()));
                }
            }
        };
        match doc.flavor {
            Flavor::Schema => {
                if let Value::Object(m) = v
                    && m.keys().any(|k| {
                        STRUCTURAL.contains(&k.as_str())
                            || matches!(
                                k.as_str(),
                                "type" | "allOf" | "anyOf" | "oneOf" | "$ref" | "enum" | "const"
                            )
                    })
                    && !m.contains_key("swagger")
                {
                    out.push((String::new(), stem(&doc.name)));
                }
            }
            Flavor::OpenApi => map("/components/schemas".into(), &mut out),
            Flavor::AsyncApi => {
                map("/components/schemas".into(), &mut out);
                if let Some(Value::Object(msgs)) = v.pointer("/components/messages") {
                    for (k, msg) in msgs {
                        let Some(p) = msg.get("payload") else {
                            continue;
                        };
                        let ptr = format!("{}/payload", child("/components/messages", k));
                        if p.get("schemaFormat").is_some() {
                            if p.get("schema").is_some()
                                && p["schemaFormat"].as_str().is_some_and(|f| {
                                    f.contains("json")
                                        || f.contains("asyncapi")
                                        || f.contains("openapi")
                                })
                            {
                                out.push((format!("{ptr}/schema"), k.clone()));
                            }
                        } else {
                            out.push((ptr, k.clone()));
                        }
                    }
                }
            }
        }
        defs(v, "", "", &mut out);
        out
    }

    pub fn run(&mut self) {
        let entries: Vec<Vec<(String, String)>> =
            (0..self.docs.len()).map(|d| self.entries(d)).collect();
        // One namespace per file only when names would clash between files.
        let mut seen: HashMap<&str, usize> = HashMap::new();
        let mut clash = false;
        for (d, list) in entries.iter().enumerate() {
            for (_, n) in list {
                if *seen.entry(n.as_str()).or_insert(d) != d {
                    clash = true;
                }
            }
        }
        if clash {
            let mut prefixes: HashSet<String> = HashSet::new();
            for (d, doc) in self.docs.iter().enumerate() {
                if doc.value.is_none() {
                    continue;
                }
                let uri = doc
                    .value
                    .as_ref()
                    .and_then(|v| v.get("$id").or_else(|| v.get("id")))
                    .and_then(Value::as_str)
                    .map_or_else(|| doc.display.clone(), str::to_string);
                let mut p: String = stem(&doc.display)
                    .chars()
                    .map(|c| {
                        if c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.' {
                            c
                        } else {
                            '_'
                        }
                    })
                    .collect();
                if p.is_empty() {
                    p = "ns".into();
                }
                let mut q = p.clone();
                let mut n = 2;
                while !prefixes.insert(q.clone()) {
                    q = format!("{p}{n}");
                    n += 1;
                }
                self.file_ns[d] = Some(self.namespaces.len() as NsId);
                self.namespaces.push(Namespace { uri, prefix: q });
            }
        }
        for (d, list) in entries.into_iter().enumerate() {
            for (ptr, name) in list {
                let Some(v) = self.value(d, &ptr) else {
                    continue;
                };
                // A named schema that is only a `$ref` (OpenAPI components
                // pointing into other files) names its target instead.
                if let Value::Object(m) = v
                    && let Some(Value::String(r)) = refkw(m)
                    && is_ref_only(m)
                    && let Some(t) = self.reg.resolve(self.docs, d, &ptr, r)
                    && t.0 != d
                    && self.value(t.0, &t.1).is_some_and(Value::is_object)
                {
                    let id = self.global(t.0, &t.1, &name);
                    self.globals.insert((d, ptr), id);
                    continue;
                }
                if v.is_object() || v.is_boolean() {
                    self.global(d, &ptr, &name);
                }
            }
        }
        while let Some((id, d, ptr)) = self.queue.pop_front() {
            self.fill(id, d, &ptr);
        }
        // Mixins: the properties of the other `allOf` references.
        for (id, from) in std::mem::take(&mut self.mixins) {
            let extra = self.components[from as usize]
                .complex_type
                .as_ref()
                .and_then(|c| c.content.clone());
            let Some(extra) = extra else { continue };
            let Some(ct) = self.components[id as usize].complex_type.as_mut() else {
                continue;
            };
            let mine = ct.content.take();
            let mut items = match extra {
                Particle::All { items, .. } => items,
                p => vec![p],
            };
            match mine {
                Some(Particle::All { items: own, .. }) => items.extend(own),
                Some(p) => items.push(p),
                None => {}
            }
            ct.content = Some(Particle::All {
                items,
                occurs: Occurs::default(),
            });
        }
        // External files that nothing was found for.
        for (d, doc) in self.docs.iter().enumerate() {
            for (loc, file) in &doc.refs {
                if file.is_some() {
                    continue;
                }
                let base = self.reg.base_of(self.docs, d, "");
                if self.reg.resources.contains_key(&resolve_uri(&base, loc)) {
                    continue;
                }
                self.diagnostics.push(Diagnostic {
                    level: Level::Warning,
                    code: "unresolved-import".into(),
                    message: format!("schema {loc} referenced with $ref was not found"),
                    file: Some(d as FileId),
                    line: 0,
                });
            }
        }
    }

    fn unique(&mut self, ns: Option<NsId>, name: &str) -> String {
        let mut n = name.to_string();
        let mut i = 2;
        while !self.taken.insert((ns, n.clone())) {
            n = format!("{name}_{i}");
            i += 1;
        }
        n
    }

    fn global(&mut self, d: usize, ptr: &str, name: &str) -> Id {
        if let Some(&id) = self.globals.get(&(d, ptr.to_string())) {
            return id;
        }
        let simple = self.is_simple(d, ptr, 0);
        let ns = self.file_ns[d];
        let name = self.unique(ns, name);
        let mut c = Component::new(
            if simple {
                Kind::SimpleType
            } else {
                Kind::ComplexType
            },
            name,
        );
        c.ns = ns;
        c.file = Some(d as FileId);
        c.json = Some(Box::new(JsonInfo {
            pointer: ptr.to_string(),
            ..Default::default()
        }));
        let id = self.components.len() as Id;
        self.components.push(c);
        self.globals.insert((d, ptr.to_string()), id);
        self.file_globals[d] += 1;
        self.queue.push_back((id, d, ptr.to_string()));
        id
    }

    fn is_simple(&mut self, d: usize, ptr: &str, depth: u32) -> bool {
        let Some(Value::Object(m)) = self.value(d, ptr) else {
            return true;
        };
        if depth > 12 {
            return false;
        }
        if m.keys().any(|k| STRUCTURAL.contains(&k.as_str())) {
            return false;
        }
        if types(m).iter().any(|t| t == "object" || t == "array") {
            return false;
        }
        if let Some(Value::String(r)) = refkw(m)
            && let Some(t) = self.reg.resolve(self.docs, d, ptr, r)
        {
            if let Some(&s) = self.simple_memo.get(&t) {
                if !s {
                    return false;
                }
            } else {
                self.simple_memo.insert(t.clone(), true);
                let s = self.is_simple(t.0, &t.1, depth + 1);
                self.simple_memo.insert(t, s);
                if !s {
                    return false;
                }
            }
        }
        for k in ["allOf", "oneOf", "anyOf"] {
            if let Some(Value::Array(a)) = m.get(k) {
                for i in 0..a.len() {
                    let p = child(&child(ptr, k), &i.to_string());
                    if !self.is_simple(d, &p, depth + 1) {
                        return false;
                    }
                }
            }
        }
        true
    }

    fn builtin(&mut self, name: &str) -> Ref {
        if let Some(&id) = self.builtins.get(name) {
            return Ref::Id(id);
        }
        let mut c = Component::new(Kind::SimpleType, name.to_string());
        c.builtin = true;
        c.simple_type = Some(SimpleInfo {
            variety: Variety::Atomic,
            base: None,
            item: None,
            members: Vec::new(),
            facets: Vec::new(),
            enumerations: Vec::new(),
            r#final: None,
            derived: Vec::new(),
        });
        c.json = Some(Box::new(JsonInfo {
            kind: name.to_string(),
            ..Default::default()
        }));
        let id = self.components.len() as Id;
        self.components.push(c);
        self.builtins.insert(name.to_string(), id);
        Ref::Id(id)
    }

    fn uses(&mut self, r: &Ref, by: Id, how: UseKind) {
        if let Ref::Id(t) = r
            && !self.components[*t as usize].builtin
        {
            self.usages.push((*t, Usage { by, how }));
        }
    }

    /// Follow a `$ref` (held by the object at `ptr`) to its global type.
    fn ref_to(&mut self, d: usize, ptr: &str, r: &str, by: Id, how: UseKind) -> Ref {
        let target = self.reg.resolve(self.docs, d, ptr, r);
        match target {
            Some((td, tptr))
                if self
                    .value(td, &tptr)
                    .is_some_and(|v| v.is_object() || v.is_boolean()) =>
            {
                let name = if tptr.is_empty() {
                    stem(&self.docs[td].name)
                } else {
                    name_hint(&tptr).unwrap_or_else(|| stem(&self.docs[td].name))
                };
                let g = self.global(td, &tptr, &name);
                let r = Ref::Id(g);
                self.uses(&r, by, how);
                r
            }
            _ => {
                self.unresolved_refs += 1;
                self.diagnostics.push(Diagnostic {
                    level: Level::Warning,
                    code: "unresolved-ref".into(),
                    message: format!(
                        "$ref {r} at {} not resolved",
                        if ptr.is_empty() { "/" } else { ptr }
                    ),
                    file: Some(d as FileId),
                    line: 0,
                });
                Ref::Missing(r.to_string())
            }
        }
    }

    /// The type of the schema at `ptr`: a global, a built-in or a new
    /// anonymous type owned by `owner`.
    fn type_ref(&mut self, d: usize, ptr: &str, owner: Id, how: UseKind) -> Option<Ref> {
        if let Some(&g) = self.globals.get(&(d, ptr.to_string())) {
            let r = Ref::Id(g);
            self.uses(&r, owner, how);
            return Some(r);
        }
        match self.value(d, ptr)? {
            Value::Bool(_) => Some(self.builtin("any")),
            Value::Object(m) => {
                if let Some(Value::String(r)) = refkw(m)
                    && is_ref_only(m)
                {
                    return Some(self.ref_to(d, ptr, r, owner, how));
                }
                // `allOf: [{$ref}]` next to annotations only: a plain reference too.
                if let Some(Value::Array(all)) = m.get("allOf")
                    && let [Value::Object(one)] = all.as_slice()
                    && let Some(Value::String(r)) = refkw(one)
                    && is_ref_only(one)
                    && m.keys().all(|k| k == "allOf" || is_annotation(k))
                {
                    let holder = child(&child(ptr, "allOf"), "0");
                    return Some(self.ref_to(d, &holder, r, owner, how));
                }
                if let Some(t) = plain_type(m) {
                    return Some(self.builtin(&t));
                }
                let simple = self.is_simple(d, ptr, 0);
                let mut c = Component::new(
                    if simple {
                        Kind::SimpleType
                    } else {
                        Kind::ComplexType
                    },
                    String::new(),
                );
                c.parent = Some(owner);
                c.file = Some(d as FileId);
                c.json = Some(Box::new(JsonInfo {
                    pointer: ptr.to_string(),
                    ..Default::default()
                }));
                let id = self.components.len() as Id;
                self.components.push(c);
                self.fill(id, d, ptr);
                Some(Ref::Id(id))
            }
            _ => None,
        }
    }

    fn annotate(&mut self, id: Id, v: &Value) {
        let Value::Object(m) = v else { return };
        let c = &mut self.components[id as usize];
        let j = c.json.get_or_insert_with(Default::default);
        let desc = m.get("description").and_then(Value::as_str);
        let title = m.get("title").and_then(Value::as_str);
        if let Some(t) = desc.or(title)
            && !t.trim().is_empty()
        {
            c.docs.push(doc(t));
        }
        if desc.is_some() {
            j.title = title.map(str::to_string);
        }
        if let Some(Value::Array(a)) = m.get("examples") {
            j.examples.extend(a.iter().map(Value::to_string));
        }
        if let Some(e) = m.get("example") {
            j.examples.push(e.to_string());
        }
        j.deprecated = m.get("deprecated") == Some(&Value::Bool(true));
        j.read_only = m.get("readOnly") == Some(&Value::Bool(true));
        j.write_only = m.get("writeOnly") == Some(&Value::Bool(true));
    }

    fn fill(&mut self, id: Id, d: usize, ptr: &str) {
        let Some(v) = self.value(d, ptr) else { return };
        self.annotate(id, v);
        if self.components[id as usize].kind == Kind::SimpleType {
            self.simple(id, d, ptr, v);
        } else {
            self.complex(id, d, ptr, v);
        }
    }

    fn simple(&mut self, id: Id, d: usize, ptr: &str, v: &'a Value) {
        let mut info = SimpleInfo {
            variety: Variety::Atomic,
            base: None,
            item: None,
            members: Vec::new(),
            facets: Vec::new(),
            enumerations: Vec::new(),
            r#final: None,
            derived: Vec::new(),
        };
        let mut kind = String::from("any");
        if let Value::Object(m) = v {
            let draft = self.docs[d].draft;
            let mut parts: Vec<(String, &Map<String, Value>)> = vec![(ptr.to_string(), m)];
            if let Some(Value::Array(a)) = m.get("allOf") {
                for (i, p) in a.iter().enumerate() {
                    if let Value::Object(pm) = p {
                        parts.push((child(&child(ptr, "allOf"), &i.to_string()), pm));
                    }
                }
            }
            for (pp, pm) in &parts {
                if let Some(Value::String(r)) = refkw(pm) {
                    let r = self.ref_to(d, pp, r, id, UseKind::Base);
                    if info.base.is_none() {
                        info.base = Some(r);
                    }
                }
                info.facets.extend(facets(pm, draft));
                info.enumerations.extend(enumerations(pm));
            }
            let t: Vec<String> = types(m).into_iter().filter(|t| t != "null").collect();
            if let Some(first) = t.first() {
                kind = first.clone();
            }
            if info.base.is_none() {
                if t.len() == 1 {
                    info.base = Some(self.builtin(&t[0]));
                } else if t.len() > 1 {
                    info.variety = Variety::Union;
                    kind = "union".into();
                    for x in &t {
                        let r = self.builtin(x);
                        info.members.push(r);
                    }
                }
            }
            for k in ["oneOf", "anyOf"] {
                let Some(Value::Array(alts)) = m.get(k) else {
                    continue;
                };
                if alts.iter().all(|a| a.get("const").is_some()) {
                    for a in alts {
                        let mut e = Enumeration {
                            value: text(&a["const"]),
                            docs: Vec::new(),
                            appinfo: Vec::new(),
                            line: 0,
                        };
                        if let Some(t) = a
                            .get("description")
                            .or_else(|| a.get("title"))
                            .and_then(Value::as_str)
                        {
                            e.docs.push(doc(t));
                        }
                        info.enumerations.push(e);
                    }
                    continue;
                }
                info.variety = Variety::Union;
                kind = "union".into();
                for i in 0..alts.len() {
                    let ap = child(&child(ptr, k), &i.to_string());
                    if let Some(r) = self.type_ref(d, &ap, id, UseKind::Member) {
                        info.members.push(r);
                    }
                }
            }
            if info.base.is_none() && info.members.is_empty() {
                let mut vals: Vec<&Value> = m
                    .get("enum")
                    .and_then(Value::as_array)
                    .map(|a| a.iter().collect())
                    .unwrap_or_default();
                for k in ["oneOf", "anyOf"] {
                    if let Some(Value::Array(alts)) = m.get(k) {
                        vals.extend(alts.iter().filter_map(|a| a.get("const")));
                    }
                }
                let guess = if !vals.is_empty() && vals.iter().all(|v| v.is_string()) {
                    "string"
                } else if !vals.is_empty() && vals.iter().all(|v| v.is_number()) {
                    "number"
                } else {
                    "any"
                };
                if guess != "any" {
                    kind = guess.into();
                }
                info.base = Some(self.builtin(guess));
            }
            if kind == "any"
                && let Some(Ref::Id(b)) = &info.base
                && let Some(j) = &self.components[*b as usize].json
            {
                kind = j.kind.clone();
            }
        } else {
            info.base = Some(self.builtin("any"));
        }
        let c = &mut self.components[id as usize];
        if let Some(j) = c.json.as_mut() {
            j.kind = kind;
        }
        c.simple_type = Some(info);
    }

    fn gather(
        &mut self,
        id: Id,
        d: usize,
        ptr: &str,
        m: &'a Map<String, Value>,
        parts: &mut Parts,
        depth: u32,
    ) {
        let draft = self.docs[d].draft;
        if let Some(Value::String(r)) = refkw(m) {
            let r = self.ref_to(d, ptr, r, id, UseKind::Base);
            if parts.base.is_none() {
                parts.base = Some(r);
            } else if let Ref::Id(t) = r {
                parts.mixins.push(t);
            }
        }
        if let Some(Value::Object(props)) = m.get("properties") {
            for k in props.keys() {
                if !parts.props.iter().any(|(n, _)| n == k) {
                    parts
                        .props
                        .push((k.clone(), child(&child(ptr, "properties"), k)));
                }
            }
        }
        if let Some(Value::Array(req)) = m.get("required") {
            for r in req.iter().filter_map(Value::as_str) {
                if !parts.required.iter().any(|x| x == r) {
                    parts.required.push(r.to_string());
                }
            }
        }
        if let Some(Value::Object(pp)) = m.get("patternProperties") {
            for k in pp.keys() {
                parts
                    .pattern
                    .push((k.clone(), child(&child(ptr, "patternProperties"), k)));
            }
        }
        match m.get("additionalProperties") {
            Some(Value::Bool(b)) => parts.open = Some(*b),
            Some(Value::Object(_)) => parts.additional = Some(child(ptr, "additionalProperties")),
            _ => {}
        }
        if m.get("unevaluatedProperties") == Some(&Value::Bool(false)) {
            parts.closed_unevaluated = true;
        }
        for (k, any) in [("oneOf", false), ("anyOf", true)] {
            if let Some(Value::Array(a)) = m.get(k)
                && !a.is_empty()
            {
                parts.choices.push((any, child(ptr, k)));
            }
        }
        parts.facets.extend(facets(m, draft));
        parts.enums.extend(enumerations(m));
        if let Some(Value::Array(all)) = m.get("allOf")
            && depth < 8
        {
            for (i, p) in all.iter().enumerate() {
                let pp = child(&child(ptr, "allOf"), &i.to_string());
                if let Value::Object(pm) = p {
                    self.gather(id, d, &pp, pm, parts, depth + 1);
                }
            }
        }
    }

    fn new_element(&mut self, owner: Id, d: usize, ptr: &str, name: &str, role: &str) -> Id {
        let mut c = Component::new(Kind::Element, name.to_string());
        c.parent = Some(owner);
        c.file = Some(d as FileId);
        c.json = Some(Box::new(JsonInfo {
            kind: role.to_string(),
            pointer: ptr.to_string(),
            ..Default::default()
        }));
        let id = self.components.len() as Id;
        self.components.push(c);
        id
    }

    /// A local element for the property (or other subschema) at `ptr`.
    fn property(
        &mut self,
        owner: Id,
        d: usize,
        ptr: &str,
        name: &str,
        role: &str,
        occurs: Occurs,
    ) -> Particle {
        let el = self.new_element(owner, d, ptr, name, role);
        let v = self.value(d, ptr);
        let mut info = ElementInfo::default();
        let mut occurs = occurs;
        let mut tptr = ptr.to_string();
        if let Some(v) = v {
            self.annotate(el, v);
            if let Value::Object(m) = v {
                if role == "property"
                    && refkw(m).is_none()
                    && !self.globals.contains_key(&(d, ptr.to_string()))
                    && is_array_schema(m)
                    && m.get("items")
                        .is_some_and(|i| i.is_object() || i.is_boolean())
                    && !m.contains_key("prefixItems")
                    && !m
                        .keys()
                        .any(|k| matches!(k.as_str(), "properties" | "oneOf" | "anyOf" | "allOf"))
                {
                    let n = |k: &str| {
                        m.get(k)
                            .and_then(Value::as_u64)
                            .map(|x| x.min(u32::MAX as u64) as u32)
                    };
                    let min = n("minItems").unwrap_or(0);
                    occurs = Occurs {
                        min: if occurs.min > 0 { min.max(1) } else { 0 },
                        max: n("maxItems"),
                    };
                    tptr = child(ptr, "items");
                    if let Some(j) = self.components[el as usize].json.as_mut() {
                        j.array = true;
                    }
                }
                info.default = m.get("default").map(text);
                info.fixed = m.get("const").map(text);
            }
        }
        info.r#type = self.type_ref(d, &tptr, el, UseKind::Type);
        self.components[el as usize].element = Some(info);
        Particle::Element {
            el: Ref::Id(el),
            occurs,
        }
    }

    fn complex(&mut self, id: Id, d: usize, ptr: &str, v: &'a Value) {
        let mut ct = ComplexInfo::default();
        let mut kind = "object";
        if let Value::Object(m) = v {
            kind = shape(m);
            let mut parts = Parts::default();
            self.gather(id, d, ptr, m, &mut parts, 0);
            if let Some(base) = parts.base.take() {
                ct.derivation = Some(Derivation {
                    method: Method::Extension,
                    base,
                    simple: false,
                });
            }
            for t in &parts.mixins {
                self.mixins.push((id, *t));
            }
            let mut items: Vec<Particle> = Vec::new();
            for (name, pp) in std::mem::take(&mut parts.props) {
                let req = parts.required.contains(&name);
                let occ = Occurs {
                    min: req as u32,
                    max: Some(1),
                };
                items.push(self.property(id, d, &pp, &name, "property", occ));
            }
            let many = Occurs { min: 0, max: None };
            for (name, pp) in std::mem::take(&mut parts.pattern) {
                items.push(self.property(id, d, &pp, &name, "patternProperty", many));
            }
            if let Some(pp) = parts.additional.take() {
                items.push(self.property(id, d, &pp, "*", "additionalProperties", many));
            }
            if parts.open == Some(true) {
                items.push(Particle::Any {
                    wildcard: Wildcard::default(),
                    occurs: many,
                });
            }
            let f = |k: &str, v: &str| Facet {
                kind: k.into(),
                value: v.into(),
                fixed: false,
            };
            if parts.open == Some(false) {
                parts.facets.push(f("additionalProperties", "false"));
            }
            if parts.closed_unevaluated {
                parts.facets.push(f("unevaluatedProperties", "false"));
            }
            let own: HashSet<String> = items
                .iter()
                .filter_map(|p| match p {
                    Particle::Element { el: Ref::Id(e), .. } => {
                        Some(self.components[*e as usize].name.clone())
                    }
                    _ => None,
                })
                .collect();
            for r in &parts.required {
                if !own.contains(r) {
                    parts.facets.push(f("required", r));
                }
            }
            // Arrays: tuple items, then the item schema.
            if is_array_schema(m) {
                let tuple = if self.docs[d].draft >= Draft::D2020 || m.contains_key("prefixItems") {
                    "prefixItems"
                } else {
                    "items"
                };
                if let Some(Value::Array(a)) = m.get(tuple) {
                    for i in 0..a.len() {
                        let pp = child(&child(ptr, tuple), &i.to_string());
                        items.push(self.property(
                            id,
                            d,
                            &pp,
                            &format!("[{i}]"),
                            "items",
                            Occurs::default(),
                        ));
                    }
                }
                let rest = if tuple == "items" && m.get("items").is_some_and(Value::is_array) {
                    "additionalItems"
                } else {
                    "items"
                };
                if m.get(rest)
                    .is_some_and(|x| x.is_object() || x == &Value::Bool(true))
                {
                    let n = |k: &str| {
                        m.get(k)
                            .and_then(Value::as_u64)
                            .map(|x| x.min(u32::MAX as u64) as u32)
                    };
                    let occ = Occurs {
                        min: n("minItems").unwrap_or(0),
                        max: n("maxItems"),
                    };
                    let pp = child(ptr, rest);
                    items.push(self.property(id, d, &pp, "items", "items", occ));
                }
            }
            for (any, cp) in std::mem::take(&mut parts.choices) {
                let n = self
                    .value(d, &cp)
                    .and_then(Value::as_array)
                    .map_or(0, Vec::len);
                let mut alts = Vec::new();
                for i in 0..n {
                    let ap = child(&cp, &i.to_string());
                    let name = self.option_name(d, &ap, i);
                    alts.push(self.property(id, d, &ap, &name, "option", Occurs::default()));
                }
                items.push(Particle::Choice {
                    items: alts,
                    occurs: Occurs {
                        min: 1,
                        max: if any { None } else { Some(1) },
                    },
                });
            }
            ct.facets = parts.facets;
            ct.enumerations = parts.enums;
            ct.content = match items.len() {
                0 => None,
                1 if matches!(items[0], Particle::Choice { .. }) => items.pop(),
                _ => Some(Particle::All {
                    items,
                    occurs: Occurs::default(),
                }),
            };
        }
        let c = &mut self.components[id as usize];
        if let Some(j) = c.json.as_mut() {
            j.kind = kind.to_string();
        }
        c.complex_type = Some(ct);
    }

    /// The name of a `oneOf`/`anyOf` alternative: the type it refers to,
    /// its title, its JSON type or its position.
    fn option_name(&mut self, d: usize, ptr: &str, i: usize) -> String {
        let Some(Value::Object(m)) = self.value(d, ptr) else {
            return format!("option{}", i + 1);
        };
        if let Some(Value::String(r)) = refkw(m)
            && let Some((td, tp)) = self.reg.resolve(self.docs, d, ptr, r)
        {
            return if tp.is_empty() {
                stem(&self.docs[td].name)
            } else if let Some(&g) = self.globals.get(&(td, tp.clone())) {
                self.components[g as usize].name.clone()
            } else {
                name_hint(&tp).unwrap_or_else(|| stem(&self.docs[td].name))
            };
        }
        if let Some(t) = m.get("title").and_then(Value::as_str) {
            return t.to_string();
        }
        if let Some(t) = types(m).first() {
            return t.clone();
        }
        format!("option{}", i + 1)
    }
}

/// Named definitions (`$defs`, `definitions`) anywhere in a file.
fn defs(v: &Value, ptr: &str, parent: &str, out: &mut Vec<(String, String)>) {
    match v {
        Value::Object(m) => {
            if !matches!(parent, "properties" | "patternProperties") {
                for k in ["$defs", "definitions"] {
                    if let Some(Value::Object(d)) = m.get(k) {
                        let dp = child(ptr, k);
                        for name in d.keys() {
                            let p = child(&dp, name);
                            if !out.iter().any(|(x, _)| *x == p) {
                                out.push((p, name.clone()));
                            }
                        }
                    }
                }
            }
            for (k, c) in m {
                if !DATA.contains(&k.as_str()) && (c.is_object() || c.is_array()) {
                    defs(c, &child(ptr, k), k, out);
                }
            }
        }
        Value::Array(a) => {
            for (i, c) in a.iter().enumerate() {
                defs(c, &child(ptr, &i.to_string()), "", out);
            }
        }
        _ => {}
    }
}

/// The schema at `pointer` in a JSON or YAML file, as indented JSON (for
/// the source view of the viewer).
pub fn source(name: &str, bytes: &[u8], pointer: &str) -> Option<String> {
    let v = parse(name, bytes).ok()?;
    serde_json::to_string_pretty(v.pointer(pointer)?).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uris() {
        assert_eq!(
            resolve_uri("https://x.org/a/b.json", "c.json"),
            "https://x.org/a/c.json"
        );
        assert_eq!(
            resolve_uri("https://x.org/a/b.json", "../c.json"),
            "https://x.org/c.json"
        );
        assert_eq!(
            resolve_uri("https://x.org/a/b.json", "/d/e.json"),
            "https://x.org/d/e.json"
        );
        assert_eq!(resolve_uri("dir/a.json", "b.yaml"), "dir/b.yaml");
        assert_eq!(resolve_uri("dir/a.json", "urn:x:y"), "urn:x:y");
        assert_eq!(percent_decode("/a%20b"), "/a b");
        assert_eq!(
            name_hint("/components/responses/Err/content/application~1json/schema").as_deref(),
            Some("Err")
        );
        assert_eq!(stem("x/address.schema.json"), "address");
    }
}
