//! Reading the components of the loaded schema documents into the bundle.
//!
//! Pass 1 registers every global component (and every identity constraint)
//! under its qualified name; pass 2 reads their content and the local
//! declarations, resolving references by qualified name.

use crate::bundle::*;
use crate::input::{LoadedFile, XML, XS};
use roxmltree::{Document, Node, NodeId};
use std::collections::{BTreeMap, HashMap, HashSet};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum Space {
    Type,
    Element,
    Attribute,
    AttributeGroup,
    Group,
    Identity,
}

fn space_of(kind: Kind) -> Space {
    match kind {
        Kind::ComplexType | Kind::SimpleType => Space::Type,
        Kind::Element => Space::Element,
        Kind::Attribute => Space::Attribute,
        Kind::AttributeGroup => Space::AttributeGroup,
        Kind::Group => Space::Group,
        Kind::Key | Kind::Keyref | Kind::Unique => Space::Identity,
    }
}

fn kind_of(name: &str) -> Option<Kind> {
    Some(match name {
        "element" => Kind::Element,
        "complexType" => Kind::ComplexType,
        "simpleType" => Kind::SimpleType,
        "attribute" => Kind::Attribute,
        "attributeGroup" => Kind::AttributeGroup,
        "group" => Kind::Group,
        "key" => Kind::Key,
        "keyref" => Kind::Keyref,
        "unique" => Kind::Unique,
        _ => return None,
    })
}

/// Built-in types: name, base, and whether it is a list type.
const BUILTINS: &[(&str, &str)] = &[
    ("anyType", ""),
    ("anySimpleType", "anyType"),
    ("anyAtomicType", "anySimpleType"),
    ("string", "anyAtomicType"),
    ("boolean", "anyAtomicType"),
    ("decimal", "anyAtomicType"),
    ("float", "anyAtomicType"),
    ("double", "anyAtomicType"),
    ("duration", "anyAtomicType"),
    ("dateTime", "anyAtomicType"),
    ("time", "anyAtomicType"),
    ("date", "anyAtomicType"),
    ("gYearMonth", "anyAtomicType"),
    ("gYear", "anyAtomicType"),
    ("gMonthDay", "anyAtomicType"),
    ("gDay", "anyAtomicType"),
    ("gMonth", "anyAtomicType"),
    ("hexBinary", "anyAtomicType"),
    ("base64Binary", "anyAtomicType"),
    ("anyURI", "anyAtomicType"),
    ("QName", "anyAtomicType"),
    ("NOTATION", "anyAtomicType"),
    ("normalizedString", "string"),
    ("token", "normalizedString"),
    ("language", "token"),
    ("NMTOKEN", "token"),
    ("NMTOKENS", "anySimpleType"),
    ("Name", "token"),
    ("NCName", "Name"),
    ("ID", "NCName"),
    ("IDREF", "NCName"),
    ("IDREFS", "anySimpleType"),
    ("ENTITY", "NCName"),
    ("ENTITIES", "anySimpleType"),
    ("integer", "decimal"),
    ("nonPositiveInteger", "integer"),
    ("negativeInteger", "nonPositiveInteger"),
    ("long", "integer"),
    ("int", "long"),
    ("short", "int"),
    ("byte", "short"),
    ("nonNegativeInteger", "integer"),
    ("unsignedLong", "nonNegativeInteger"),
    ("unsignedInt", "unsignedLong"),
    ("unsignedShort", "unsignedInt"),
    ("unsignedByte", "unsignedShort"),
    ("positiveInteger", "nonNegativeInteger"),
    ("dateTimeStamp", "dateTime"),
    ("dayTimeDuration", "duration"),
    ("yearMonthDuration", "duration"),
    ("error", "anySimpleType"),
];

/// Attributes of the XML namespace, available without importing it.
const XML_ATTRS: &[(&str, &str)] = &[
    ("lang", "language"),
    ("space", "NCName"),
    ("base", "anyURI"),
    ("id", "ID"),
];

const FACETS: &[&str] = &[
    "length",
    "minLength",
    "maxLength",
    "pattern",
    "whiteSpace",
    "maxInclusive",
    "maxExclusive",
    "minInclusive",
    "minExclusive",
    "totalDigits",
    "fractionDigits",
    "assertion",
    "explicitTimezone",
];

fn is_xs(n: &Node) -> bool {
    n.is_element() && n.tag_name().namespace() == Some(XS)
}

fn xs_children<'a, 'i>(n: Node<'a, 'i>) -> impl Iterator<Item = Node<'a, 'i>> {
    n.children().filter(is_xs)
}

fn name_of<'a>(n: &Node<'a, '_>) -> &'a str {
    n.tag_name().name()
}

fn flag(n: &Node, attr: &str) -> bool {
    matches!(n.attribute(attr).map(str::trim), Some("true" | "1"))
}

fn opt(n: &Node, attr: &str) -> Option<String> {
    n.attribute(attr).map(str::to_string)
}

fn occurs(n: &Node) -> Occurs {
    let num = |s: &str| -> u32 {
        let s = s.trim();
        s.parse::<u32>().unwrap_or_else(|_| {
            if !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) {
                u32::MAX
            } else {
                1
            }
        })
    };
    Occurs {
        min: n.attribute("minOccurs").map_or(1, num),
        max: match n.attribute("maxOccurs").map(str::trim) {
            None => Some(1),
            Some("unbounded") => None,
            Some(s) => Some(num(s)),
        },
    }
}

fn wildcard(n: &Node) -> Wildcard {
    Wildcard {
        namespace: opt(n, "namespace"),
        not_namespace: opt(n, "notNamespace"),
        process_contents: opt(n, "processContents"),
    }
}

/// Text of a documentation element: descendant text with lines trimmed and
/// runs of blank lines folded.
fn doc_text(n: &Node) -> String {
    let mut raw = String::new();
    for d in n.descendants().filter(|d| d.is_text()) {
        raw.push_str(d.text().unwrap_or(""));
    }
    let mut out = String::new();
    let mut blank = false;
    for line in raw.lines().map(str::trim) {
        if line.is_empty() {
            blank = !out.is_empty();
            continue;
        }
        if !out.is_empty() {
            out.push_str(if blank { "\n\n" } else { "\n" });
        }
        blank = false;
        out.push_str(line);
    }
    out
}

/// The documentation and appinfo of the `xs:annotation` children of `n`.
pub(crate) fn annotations(n: &Node) -> (Vec<Doc>, Vec<String>) {
    let mut docs = Vec::new();
    let mut appinfo = Vec::new();
    for a in xs_children(*n).filter(|a| name_of(a) == "annotation") {
        for c in xs_children(a) {
            match name_of(&c) {
                "documentation" => {
                    let text = doc_text(&c);
                    if !text.is_empty() {
                        docs.push(Doc {
                            lang: c.attribute((XML, "lang")).map(str::to_string),
                            source: opt(&c, "source"),
                            text,
                        });
                    }
                }
                "appinfo" => {
                    let input = c.document().input_text();
                    let r = c.range();
                    let whole = &input[r.clone()];
                    let inner = match (whole.find('>'), whole.rfind('<')) {
                        (Some(s), Some(e)) if s < e && !whole[..=s].ends_with("/>") => {
                            &whole[s + 1..e]
                        }
                        _ => "",
                    };
                    let inner = inner.trim();
                    if !inner.is_empty() {
                        appinfo.push(inner.to_string());
                    }
                }
                _ => {}
            }
        }
    }
    (docs, appinfo)
}

#[derive(Clone, Copy)]
struct Ctx {
    file: usize,
    /// Namespace of the components of the file.
    ns: Option<NsId>,
    /// The file has no targetNamespace and takes the including one.
    chameleon: bool,
    qualified_el: bool,
    qualified_attr: bool,
    /// The global component being read.
    global: Id,
}

pub(crate) struct Builder<'f> {
    files: &'f [LoadedFile],
    pub components: Vec<Component>,
    pub namespaces: Vec<Namespace>,
    ns_ids: HashMap<String, NsId>,
    prefixes: HashMap<String, String>,
    table: HashMap<(Space, Option<NsId>, String), Id>,
    /// Pass 1 ids of global components and identity constraints.
    pre: HashMap<(usize, NodeId), Id>,
    builtins: HashMap<(bool, &'static str), Id>,
    pub usages: Vec<(Id, Usage)>,
    pub diagnostics: Vec<Diagnostic>,
    missing: HashSet<String>,
    pub unresolved_refs: u32,
    pub file_ns: Vec<Option<NsId>>,
    pub file_globals: Vec<u32>,
}

impl<'f> Builder<'f> {
    pub fn new(files: &'f [LoadedFile]) -> Builder<'f> {
        Builder {
            files,
            components: Vec::new(),
            namespaces: Vec::new(),
            ns_ids: HashMap::new(),
            prefixes: HashMap::new(),
            table: HashMap::new(),
            pre: HashMap::new(),
            builtins: HashMap::new(),
            usages: Vec::new(),
            diagnostics: Vec::new(),
            missing: HashSet::new(),
            unresolved_refs: 0,
            file_ns: vec![None; files.len()],
            file_globals: vec![0; files.len()],
        }
    }

    /// Read all documents.
    pub fn run(&mut self, docs: &[Option<Document<'_>>]) {
        self.collect_prefixes(docs);
        self.assign_file_namespaces();
        let ctxs: Vec<Option<Ctx>> = docs
            .iter()
            .enumerate()
            .map(|(i, d)| d.as_ref().map(|d| self.ctx(i, d)))
            .collect();
        // Pass 1: register global components, then redefinitions.
        for (i, d) in docs.iter().enumerate() {
            let (Some(d), Some(ctx)) = (d, ctxs[i]) else {
                continue;
            };
            for c in xs_children(d.root_element()) {
                self.register(ctx, c, false);
            }
        }
        for (i, d) in docs.iter().enumerate() {
            let (Some(d), Some(ctx)) = (d, ctxs[i]) else {
                continue;
            };
            for r in xs_children(d.root_element())
                .filter(|r| matches!(name_of(r), "redefine" | "override"))
            {
                for c in xs_children(r) {
                    self.register(ctx, c, true);
                }
            }
        }
        // Pass 2: content.
        for (i, d) in docs.iter().enumerate() {
            let (Some(d), Some(ctx)) = (d, ctxs[i]) else {
                continue;
            };
            let root = d.root_element();
            let tops = xs_children(root).flat_map(|c| {
                if matches!(name_of(&c), "redefine" | "override") {
                    xs_children(c).collect::<Vec<_>>()
                } else {
                    vec![c]
                }
            });
            for c in tops {
                if let Some(&id) = self.pre.get(&(i, c.id())) {
                    let ctx = Ctx { global: id, ..ctx };
                    self.global(ctx, c, id);
                }
            }
        }
    }

    fn collect_prefixes(&mut self, docs: &[Option<Document<'_>>]) {
        self.prefixes.insert(XS.into(), "xs".into());
        self.prefixes.insert(XML.into(), "xml".into());
        // Prefer the prefix a schema uses for its own target namespace.
        for own in [true, false] {
            for (i, d) in docs.iter().enumerate() {
                let Some(d) = d else { continue };
                let tns = self.files[i].target_namespace.as_deref();
                for ns in d.root_element().namespaces() {
                    let Some(p) = ns.name() else { continue };
                    if own != (Some(ns.uri()) == tns) {
                        continue;
                    }
                    self.prefixes
                        .entry(ns.uri().to_string())
                        .or_insert_with(|| p.to_string());
                }
            }
        }
    }

    fn assign_file_namespaces(&mut self) {
        for (i, f) in self.files.iter().enumerate() {
            if let Some(tns) = &f.target_namespace {
                self.file_ns[i] = Some(self.ns_id(tns));
            }
        }
        // Chameleon includes take the namespace of the including schema.
        loop {
            let mut changed = false;
            for (i, f) in self.files.iter().enumerate() {
                for d in &f.directives {
                    if d.kind == DirectiveKind::Import {
                        continue;
                    }
                    if let Some(j) = d.file
                        && self.files[j].target_namespace.is_none()
                        && self.file_ns[j].is_none()
                        && self.file_ns[i].is_some()
                    {
                        self.file_ns[j] = self.file_ns[i];
                        changed = true;
                    }
                }
            }
            if !changed {
                break;
            }
        }
    }

    fn ctx(&self, i: usize, d: &Document) -> Ctx {
        let root = d.root_element();
        Ctx {
            file: i,
            ns: self.file_ns[i],
            chameleon: self.files[i].target_namespace.is_none() && self.file_ns[i].is_some(),
            qualified_el: root.attribute("elementFormDefault") == Some("qualified"),
            qualified_attr: root.attribute("attributeFormDefault") == Some("qualified"),
            global: 0,
        }
    }

    pub fn ns_id(&mut self, uri: &str) -> NsId {
        if let Some(&id) = self.ns_ids.get(uri) {
            return id;
        }
        let id = self.namespaces.len() as NsId;
        let base = self
            .prefixes
            .get(uri)
            .cloned()
            .or_else(|| prefix_from_uri(uri))
            .unwrap_or_else(|| format!("ns{}", id + 1));
        let mut prefix = base.clone();
        let mut n = 2;
        while self.namespaces.iter().any(|ns| ns.prefix == prefix) {
            prefix = format!("{base}{n}");
            n += 1;
        }
        self.namespaces.push(Namespace {
            uri: uri.to_string(),
            prefix,
        });
        self.ns_ids.insert(uri.to_string(), id);
        id
    }

    fn line(&self, ctx: Ctx, n: &Node) -> u32 {
        self.files[ctx.file].lines.line(n.range().start)
    }

    fn diag(&mut self, level: Level, code: &str, message: String, ctx: Ctx, n: &Node) {
        let line = self.line(ctx, n);
        self.diagnostics.push(Diagnostic {
            level,
            code: code.into(),
            message,
            file: Some(ctx.file as FileId),
            line,
        });
    }

    fn push(&mut self, c: Component) -> Id {
        self.components.push(c);
        (self.components.len() - 1) as Id
    }

    /// A new component for the declaration `n`, with its location and
    /// annotations.
    fn create(&mut self, ctx: Ctx, n: &Node, kind: Kind, name: &str, ns: Option<NsId>) -> Id {
        let (docs, appinfo) = annotations(n);
        let mut c = Component::new(kind, name.to_string());
        c.ns = ns;
        c.file = Some(ctx.file as FileId);
        c.line = self.line(ctx, n);
        c.docs = docs;
        c.appinfo = appinfo;
        self.push(c)
    }

    /// Pass 1: register a top-level declaration (and its identity
    /// constraints) under its name.
    fn register(&mut self, ctx: Ctx, n: Node, redefinition: bool) {
        let Some(kind) = kind_of(name_of(&n)) else {
            return;
        };
        if kind.is_identity() {
            return;
        }
        let Some(name) = n.attribute("name").map(str::trim) else {
            self.diag(
                Level::Warning,
                "no-name",
                format!("global xs:{} without a name", name_of(&n)),
                ctx,
                &n,
            );
            return;
        };
        let key = (space_of(kind), ctx.ns, name.to_string());
        let existing = self.table.get(&key).copied();
        if let Some(prev) = existing
            && !redefinition
        {
            let p = &self.components[prev as usize];
            let msg = format!(
                "{} {name} is declared again (first in {}:{})",
                name_of(&n),
                self.files[p.file.unwrap_or(0) as usize].display,
                p.line
            );
            self.diag(Level::Warning, "duplicate", msg, ctx, &n);
            return;
        }
        let id = self.create(ctx, &n, kind, name, ctx.ns);
        self.components[id as usize].redefines = existing;
        self.table.insert(key, id);
        self.pre.insert((ctx.file, n.id()), id);
        self.file_globals[ctx.file] += 1;
        for d in n.descendants().filter(is_xs) {
            let Some(k) = kind_of(name_of(&d)).filter(|k| k.is_identity()) else {
                continue;
            };
            let Some(iname) = d.attribute("name").map(str::trim) else {
                continue;
            };
            let key = (Space::Identity, ctx.ns, iname.to_string());
            if self.table.contains_key(&key) && !redefinition {
                self.diag(
                    Level::Warning,
                    "duplicate",
                    format!("identity constraint {iname} is declared again"),
                    ctx,
                    &d,
                );
                continue;
            }
            let iid = self.create(ctx, &d, k, iname, ctx.ns);
            self.table.insert(key, iid);
            self.pre.insert((ctx.file, d.id()), iid);
        }
    }

    fn builtin(&mut self, name: &str, attribute: bool) -> Option<Id> {
        let (table, ns): (&[(&'static str, &'static str)], &str) = if attribute {
            (XML_ATTRS, XML)
        } else {
            (BUILTINS, XS)
        };
        let &(static_name, base) = table.iter().find(|(n, _)| *n == name)?;
        if let Some(&id) = self.builtins.get(&(attribute, static_name)) {
            return Some(id);
        }
        let ns = self.ns_id(ns);
        let kind = if attribute {
            Kind::Attribute
        } else if name == "anyType" {
            Kind::ComplexType
        } else {
            Kind::SimpleType
        };
        let mut c = Component::new(kind, name.to_string());
        c.ns = Some(ns);
        c.builtin = true;
        let id = self.push(c);
        self.builtins.insert((attribute, static_name), id);
        let base = if base.is_empty() {
            None
        } else {
            self.builtin(base, false).map(Ref::Id)
        };
        let c = &mut self.components[id as usize];
        match kind {
            Kind::Attribute => {
                c.attribute = Some(AttributeInfo {
                    r#type: base,
                    ..Default::default()
                })
            }
            Kind::ComplexType => c.complex_type = Some(ComplexInfo::default()),
            _ => {
                let list = matches!(name, "NMTOKENS" | "IDREFS" | "ENTITIES");
                let item = list.then(|| {
                    let item = &name[..name.len() - 1];
                    let item = if item == "ENTITIE" { "ENTITY" } else { item };
                    item.to_string()
                });
                c.simple_type = Some(SimpleInfo {
                    variety: if list { Variety::List } else { Variety::Atomic },
                    base,
                    item: None,
                    members: Vec::new(),
                    facets: Vec::new(),
                    enumerations: Vec::new(),
                    r#final: None,
                    derived: Vec::new(),
                });
                if let Some(item) = item {
                    let item = self.builtin(&item, false).map(Ref::Id);
                    if let Some(st) = &mut self.components[id as usize].simple_type {
                        st.item = item;
                    }
                }
            }
        }
        Some(id)
    }

    /// Resolve the QName `value` (in the scope of `n`) in `space`; records
    /// the usage by `by`.
    fn resolve(
        &mut self,
        ctx: Ctx,
        n: &Node,
        value: &str,
        space: Space,
        by: Id,
        how: UseKind,
    ) -> Ref {
        let value = value.trim();
        let (prefix, local) = match value.split_once(':') {
            Some((p, l)) => (Some(p), l),
            None => (None, value),
        };
        let uri = match prefix {
            Some("xml") => Some(XML),
            _ => n.lookup_namespace_uri(prefix),
        };
        if prefix.is_some() && uri.is_none() {
            self.report_missing(ctx, n, value, format!("undeclared prefix in {value}"));
            return Ref::Missing(value.to_string());
        }
        let ns_owned: Option<String> = match uri.filter(|u| !u.is_empty()) {
            Some(u) => Some(u.to_string()),
            None if ctx.chameleon => ctx.ns.map(|i| self.namespaces[i as usize].uri.clone()),
            None => None,
        };
        let ns = ns_owned.as_deref();
        let ns_id = ns.and_then(|u| self.ns_ids.get(u).copied());
        let key = (space, ns_id, local.to_string());
        if let Some(&id) = self.table.get(&key) {
            // A redefinition refers to the component it redefines.
            let id = match self.components[id as usize].redefines {
                Some(orig) if id == ctx.global => orig,
                _ => id,
            };
            return self.used(Ref::Id(id), by, how);
        }
        let builtin = match (ns, space) {
            (Some(XS), Space::Type) => self.builtin(local, false),
            (Some(XML), Space::Attribute) => self.builtin(local, true),
            _ => None,
        };
        if let Some(id) = builtin {
            return self.used(Ref::Id(id), by, how);
        }
        let clark = match ns {
            Some(u) => format!("{{{u}}}{local}"),
            None => local.to_string(),
        };
        let what = match space {
            Space::Type => "type",
            Space::Element => "element",
            Space::Attribute => "attribute",
            Space::AttributeGroup => "attribute group",
            Space::Group => "group",
            Space::Identity => "identity constraint",
        };
        self.report_missing(
            ctx,
            n,
            &clark,
            format!("cannot find {what} {value} ({clark})"),
        );
        Ref::Missing(clark)
    }

    fn report_missing(&mut self, ctx: Ctx, n: &Node, key: &str, message: String) {
        if self.missing.insert(key.to_string()) {
            self.unresolved_refs += 1;
            self.diag(Level::Warning, "unresolved-ref", message, ctx, n);
        }
    }

    fn used(&mut self, r: Ref, by: Id, how: UseKind) -> Ref {
        if let Ref::Id(t) = r {
            self.usages.push((t, Usage { by, how }));
        }
        r
    }

    /// Pass 2 for a global component.
    fn global(&mut self, ctx: Ctx, n: Node, id: Id) {
        match self.components[id as usize].kind {
            Kind::Element => self.element(ctx, n, id),
            Kind::ComplexType => self.complex(ctx, n, id),
            Kind::SimpleType => self.simple(ctx, n, id),
            Kind::Attribute => self.attribute(ctx, n, id, true),
            Kind::AttributeGroup => {
                let mut info = AttributeGroupInfo::default();
                self.attr_items(ctx, n, id, &mut info.attributes, &mut info.any_attribute);
                self.components[id as usize].attribute_group = Some(info);
            }
            Kind::Group => {
                let p = xs_children(n).find_map(|c| self.particle(ctx, c, id));
                self.components[id as usize].group = p;
            }
            _ => {}
        }
    }

    fn local(
        &mut self,
        ctx: Ctx,
        n: &Node,
        kind: Kind,
        name: &str,
        ns: Option<NsId>,
        parent: Id,
    ) -> Id {
        let id = self.create(ctx, n, kind, name, ns);
        self.components[id as usize].parent = Some(parent);
        id
    }

    fn anonymous_type(&mut self, ctx: Ctx, c: Node, parent: Id) -> Option<Ref> {
        let id = match name_of(&c) {
            "complexType" => {
                let id = self.local(ctx, &c, Kind::ComplexType, "", None, parent);
                self.complex(ctx, c, id);
                id
            }
            "simpleType" => {
                let id = self.local(ctx, &c, Kind::SimpleType, "", None, parent);
                self.simple(ctx, c, id);
                id
            }
            _ => return None,
        };
        Some(Ref::Id(id))
    }

    fn element(&mut self, ctx: Ctx, n: Node, id: Id) {
        let mut info = ElementInfo {
            r#abstract: flag(&n, "abstract"),
            nillable: flag(&n, "nillable"),
            default: opt(&n, "default"),
            fixed: opt(&n, "fixed"),
            r#final: opt(&n, "final"),
            block: opt(&n, "block"),
            ..Default::default()
        };
        if let Some(t) = n.attribute("type") {
            info.r#type = Some(self.resolve(ctx, &n, t, Space::Type, id, UseKind::Type));
        }
        if let Some(sg) = n.attribute("substitutionGroup") {
            for h in sg.split_whitespace() {
                let r = self.resolve(ctx, &n, h, Space::Element, id, UseKind::Substitution);
                info.substitution_group.push(r);
            }
        }
        for c in xs_children(n) {
            match name_of(&c) {
                "complexType" | "simpleType" => {
                    if info.r#type.is_none() {
                        info.r#type = self.anonymous_type(ctx, c, id);
                    }
                }
                "key" | "keyref" | "unique" => {
                    let iid = match self.pre.get(&(ctx.file, c.id())) {
                        Some(&iid) => iid,
                        None => {
                            let kind = kind_of(name_of(&c)).unwrap_or(Kind::Key);
                            let name = c.attribute("name").unwrap_or("");
                            self.create(ctx, &c, kind, name, ctx.ns)
                        }
                    };
                    self.components[iid as usize].parent = Some(id);
                    self.identity(ctx, c, iid);
                    info.identity.push(iid);
                }
                _ => {}
            }
        }
        self.components[id as usize].element = Some(info);
    }

    fn identity(&mut self, ctx: Ctx, n: Node, id: Id) {
        let mut info = IdentityInfo::default();
        for c in xs_children(n) {
            match name_of(&c) {
                "selector" => info.selector = c.attribute("xpath").unwrap_or("").to_string(),
                "field" => info
                    .fields
                    .push(c.attribute("xpath").unwrap_or("").to_string()),
                _ => {}
            }
        }
        if let Some(r) = n.attribute("refer") {
            info.refer = Some(self.resolve(ctx, &n, r, Space::Identity, id, UseKind::Refer));
        }
        self.components[id as usize].identity = Some(info);
    }

    fn complex(&mut self, ctx: Ctx, n: Node, id: Id) {
        let mut ct = ComplexInfo {
            mixed: flag(&n, "mixed"),
            r#abstract: flag(&n, "abstract"),
            r#final: opt(&n, "final"),
            block: opt(&n, "block"),
            ..Default::default()
        };
        for c in xs_children(n) {
            let simple = match name_of(&c) {
                "simpleContent" => true,
                "complexContent" => false,
                _ => continue,
            };
            if !simple && c.has_attribute("mixed") {
                ct.mixed = flag(&c, "mixed");
            }
            for d in xs_children(c) {
                let method = match name_of(&d) {
                    "extension" => Method::Extension,
                    "restriction" => Method::Restriction,
                    _ => continue,
                };
                let base = match d.attribute("base") {
                    Some(b) => self.resolve(ctx, &d, b, Space::Type, id, UseKind::Base),
                    None => match xs_children(d).find(|x| name_of(x) == "simpleType") {
                        Some(st) => self
                            .anonymous_type(ctx, st, id)
                            .unwrap_or(Ref::Missing(String::new())),
                        None => Ref::Missing(String::new()),
                    },
                };
                ct.derivation = Some(Derivation {
                    method,
                    base,
                    simple,
                });
                self.content(ctx, d, id, &mut ct);
            }
        }
        self.content(ctx, n, id, &mut ct);
        self.components[id as usize].complex_type = Some(ct);
    }

    fn content(&mut self, ctx: Ctx, n: Node, id: Id, ct: &mut ComplexInfo) {
        for c in xs_children(n) {
            match name_of(&c) {
                "sequence" | "choice" | "all" | "group" => ct.content = self.particle(ctx, c, id),
                "assert" => ct
                    .asserts
                    .push(c.attribute("test").unwrap_or("").to_string()),
                "enumeration" => ct.enumerations.push(self.enumeration(ctx, c)),
                f if FACETS.contains(&f) => ct.facets.push(facet(c)),
                _ => {}
            }
        }
        self.attr_items(ctx, n, id, &mut ct.attributes, &mut ct.any_attribute);
    }

    fn particle(&mut self, ctx: Ctx, n: Node, owner: Id) -> Option<Particle> {
        let occurs = occurs(&n);
        Some(match name_of(&n) {
            "element" => {
                let el = match n.attribute("ref") {
                    Some(r) => self.resolve(ctx, &n, r, Space::Element, owner, UseKind::Element),
                    None => Ref::Id(self.local_element(ctx, n, owner)),
                };
                Particle::Element { el, occurs }
            }
            "group" => {
                let r = n.attribute("ref").unwrap_or("");
                let group = self.resolve(ctx, &n, r, Space::Group, owner, UseKind::Group);
                Particle::Group { group, occurs }
            }
            "sequence" | "choice" | "all" => {
                let items = xs_children(n)
                    .filter_map(|c| self.particle(ctx, c, owner))
                    .collect();
                match name_of(&n) {
                    "sequence" => Particle::Sequence { items, occurs },
                    "choice" => Particle::Choice { items, occurs },
                    _ => Particle::All { items, occurs },
                }
            }
            "any" => Particle::Any {
                wildcard: wildcard(&n),
                occurs,
            },
            _ => return None,
        })
    }

    fn local_ns(&mut self, ctx: Ctx, n: &Node, qualified_default: bool) -> Option<NsId> {
        if let Some(tns) = n.attribute("targetNamespace") {
            return (!tns.is_empty()).then(|| self.ns_id(tns));
        }
        let qualified = match n.attribute("form") {
            Some(f) => f == "qualified",
            None => qualified_default,
        };
        if qualified { ctx.ns } else { None }
    }

    fn local_element(&mut self, ctx: Ctx, n: Node, owner: Id) -> Id {
        let name = n.attribute("name").unwrap_or("").trim();
        let ns = self.local_ns(ctx, &n, ctx.qualified_el);
        let id = self.local(ctx, &n, Kind::Element, name, ns, owner);
        self.element(ctx, n, id);
        id
    }

    fn attr_items(
        &mut self,
        ctx: Ctx,
        n: Node,
        owner: Id,
        items: &mut Vec<AttrItem>,
        any: &mut Option<Wildcard>,
    ) {
        for c in xs_children(n) {
            match name_of(&c) {
                "attribute" => {
                    let r#use = match c.attribute("use") {
                        Some("required") => AttrUse::Required,
                        Some("prohibited") => AttrUse::Prohibited,
                        _ => AttrUse::Optional,
                    };
                    let attr = match c.attribute("ref") {
                        Some(r) => {
                            self.resolve(ctx, &c, r, Space::Attribute, owner, UseKind::Attribute)
                        }
                        None => {
                            let name = c.attribute("name").unwrap_or("").trim();
                            let ns = self.local_ns(ctx, &c, ctx.qualified_attr);
                            let id = self.local(ctx, &c, Kind::Attribute, name, ns, owner);
                            self.attribute(ctx, c, id, false);
                            Ref::Id(id)
                        }
                    };
                    items.push(AttrItem::Attribute {
                        attr,
                        r#use,
                        default: opt(&c, "default"),
                        fixed: opt(&c, "fixed"),
                    });
                }
                "attributeGroup" => {
                    let r = c.attribute("ref").unwrap_or("");
                    let group = self.resolve(
                        ctx,
                        &c,
                        r,
                        Space::AttributeGroup,
                        owner,
                        UseKind::AttributeGroup,
                    );
                    items.push(AttrItem::Group { group });
                }
                "anyAttribute" => *any = Some(wildcard(&c)),
                _ => {}
            }
        }
    }

    fn attribute(&mut self, ctx: Ctx, n: Node, id: Id, global: bool) {
        let mut info = AttributeInfo {
            inheritable: flag(&n, "inheritable"),
            ..Default::default()
        };
        if global {
            info.default = opt(&n, "default");
            info.fixed = opt(&n, "fixed");
        }
        if let Some(t) = n.attribute("type") {
            info.r#type = Some(self.resolve(ctx, &n, t, Space::Type, id, UseKind::Type));
        } else if let Some(st) = xs_children(n).find(|c| name_of(c) == "simpleType") {
            info.r#type = self.anonymous_type(ctx, st, id);
        }
        self.components[id as usize].attribute = Some(info);
    }

    fn enumeration(&mut self, ctx: Ctx, c: Node) -> Enumeration {
        let (docs, appinfo) = annotations(&c);
        Enumeration {
            value: c.attribute("value").unwrap_or("").to_string(),
            docs,
            appinfo,
            line: self.line(ctx, &c),
        }
    }

    fn simple(&mut self, ctx: Ctx, n: Node, id: Id) {
        let mut st = SimpleInfo {
            variety: Variety::Atomic,
            base: None,
            item: None,
            members: Vec::new(),
            facets: Vec::new(),
            enumerations: Vec::new(),
            r#final: opt(&n, "final"),
            derived: Vec::new(),
        };
        for c in xs_children(n) {
            match name_of(&c) {
                "restriction" => {
                    if let Some(b) = c.attribute("base") {
                        st.base = Some(self.resolve(ctx, &c, b, Space::Type, id, UseKind::Base));
                    }
                    for f in xs_children(c) {
                        match name_of(&f) {
                            "simpleType" if st.base.is_none() => {
                                st.base = self.anonymous_type(ctx, f, id);
                            }
                            "enumeration" => {
                                let e = self.enumeration(ctx, f);
                                st.enumerations.push(e);
                            }
                            k if FACETS.contains(&k) => st.facets.push(facet(f)),
                            _ => {}
                        }
                    }
                }
                "list" => {
                    st.variety = Variety::List;
                    if let Some(t) = c.attribute("itemType") {
                        st.item = Some(self.resolve(ctx, &c, t, Space::Type, id, UseKind::Item));
                    } else if let Some(t) = xs_children(c).find(|x| name_of(x) == "simpleType") {
                        st.item = self.anonymous_type(ctx, t, id);
                    }
                }
                "union" => {
                    st.variety = Variety::Union;
                    if let Some(m) = c.attribute("memberTypes") {
                        for t in m.split_whitespace() {
                            let r = self.resolve(ctx, &c, t, Space::Type, id, UseKind::Member);
                            st.members.push(r);
                        }
                    }
                    for t in xs_children(c).filter(|x| name_of(x) == "simpleType") {
                        if let Some(r) = self.anonymous_type(ctx, t, id) {
                            st.members.push(r);
                        }
                    }
                }
                _ => {}
            }
        }
        // A restriction of a list or union keeps its variety.
        if let Some(Ref::Id(b)) = &st.base
            && let Some(bs) = &self.components[*b as usize].simple_type
            && bs.variety != Variety::Atomic
            && !self.components[*b as usize].builtin
        {
            st.variety = bs.variety;
        }
        self.components[id as usize].simple_type = Some(st);
    }

    /// Per-file prefix declarations of the schema element.
    pub fn file_prefixes(d: &Document) -> BTreeMap<String, String> {
        d.root_element()
            .namespaces()
            .map(|ns| (ns.name().unwrap_or("").to_string(), ns.uri().to_string()))
            .collect()
    }
}

/// A display prefix guessed from a namespace URI: its last word
/// (`http://www.netex.org.uk/netex` gives `netex`).
fn prefix_from_uri(uri: &str) -> Option<String> {
    let last = uri
        .trim_end_matches(['/', '#'])
        .rsplit(['/', ':', '#'])
        .find(|s| !s.is_empty())?;
    let p: String = last
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .collect();
    let ok = p.len() <= 12 && p.starts_with(|c: char| c.is_ascii_alphabetic());
    ok.then(|| p.to_lowercase())
}

fn facet(f: Node) -> Facet {
    Facet {
        kind: name_of(&f).to_string(),
        value: f
            .attribute("value")
            .or_else(|| f.attribute("test"))
            .unwrap_or("")
            .to_string(),
        fixed: flag(&f, "fixed"),
    }
}
