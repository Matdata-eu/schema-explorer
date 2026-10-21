//! Comparison of two versions of a schema set.
//!
//! [`diff`] matches the global components of two bundles (complex and
//! simple types, elements, attributes, model groups and attribute groups) by
//! qualified name and, when a version moved to another target namespace (as
//! railML does with every minor version), by kind and local name. It then
//! compares each matched pair and lists fine-grained changes, each with its
//! impact on instance documents: breaking (documents valid against the old
//! version may be invalid against the new one), non-breaking, or
//! informational (documentation).
//!
//! The result is a [`SchemaDiff`], serialized with serde like the bundle and
//! versioned by [`DIFF_FORMAT`].

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::bundle::*;

/// Version of the diff format; changes when the JSON changes incompatibly.
pub const DIFF_FORMAT: u32 = 1;

/// How deep anonymous types nested in anonymous types are compared.
const MAX_DEPTH: u32 = 24;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DiffOptions {
    /// Match components that have no counterpart with the same qualified
    /// name by kind and local name, when their target namespaces differ
    /// (a namespace that changes between versions).
    pub match_local_names: bool,
    /// Report documentation changes.
    pub docs: bool,
    /// Pair removed and added components with near-identical content as
    /// possible renames.
    pub renames: bool,
}

impl Default for DiffOptions {
    fn default() -> Self {
        DiffOptions {
            match_local_names: true,
            docs: true,
            renames: true,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    Added,
    Removed,
    Changed,
}

/// The effect of a change on instance documents.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Impact {
    /// Documents valid against the old version may be invalid against the new one.
    Breaking,
    /// Documents valid against the old version stay valid.
    NonBreaking,
    /// No effect on validation (documentation).
    Info,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ChangeKind {
    /// A complex type became a simple type or the reverse.
    KindChanged,
    /// Base type of a derivation.
    BaseChanged,
    /// Extension / restriction, simple / complex content.
    DerivationChanged,
    AbstractChanged,
    FinalChanged,
    BlockChanged,
    MixedChanged,
    NillableChanged,
    /// Type of an element or attribute declaration.
    TypeChanged,
    /// `default` / `fixed` of an element declaration.
    ValueConstraintChanged,
    /// The head(s) an element substitutes for.
    SubstitutionGroupChanged,
    SubstitutionMemberAdded,
    SubstitutionMemberRemoved,
    /// A child particle (element, group reference, wildcard) of a content model.
    ChildAdded,
    ChildRemoved,
    ChildRetyped,
    ChildCardinalityChanged,
    /// Children of a sequence in another order.
    ChildrenReordered,
    /// A child moved into another compositor (e.g. from a sequence into a choice).
    ChildMoved,
    /// The compositors (sequence, choice, all) of a content model.
    StructureChanged,
    AttributeAdded,
    AttributeRemoved,
    AttributeRetyped,
    AttributeUseChanged,
    AttributeDefaultChanged,
    AttributeFixedChanged,
    AnyAttributeChanged,
    EnumerationAdded,
    EnumerationRemoved,
    FacetAdded,
    FacetRemoved,
    FacetChanged,
    /// Atomic / list / union.
    VarietyChanged,
    ItemTypeChanged,
    MemberTypeAdded,
    MemberTypeRemoved,
    AssertAdded,
    AssertRemoved,
    DocsChanged,
}

/// One change in a component.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub kind: ChangeKind,
    pub impact: Impact,
    /// Where in the component: the names of the nested local declarations
    /// leading to it, `/`-separated (`@name` for attributes); empty for the
    /// component itself.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub path: String,
    /// What changed: the child, attribute, enumeration value or facet.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub subject: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub new: Option<String>,
}

/// A component in one of the two bundles.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Side {
    pub id: Id,
    /// `prefix:name` in that bundle.
    pub qname: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub line: u32,
}

fn is_zero(n: &u32) -> bool {
    *n == 0
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentDiff {
    /// The kind in the new version (old for a removed component).
    pub kind: Kind,
    pub status: Status,
    pub name: String,
    /// Target namespace URI (new version's, old for a removed component).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub namespace: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old: Option<Side>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub new: Option<Side>,
    /// Matched by kind and local name only (the namespace differs).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub by_local_name: bool,
    /// The worst impact: removed is breaking, added non-breaking.
    pub impact: Impact,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub changes: Vec<Change>,
    /// For a removed or added component that looks like a rename: the
    /// qualified name of the other one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub possibly_renamed: Option<String>,
}

impl ComponentDiff {
    pub fn breaking(&self) -> bool {
        self.impact == Impact::Breaking
    }
    /// The qualified name: the new one, or the old one for a removed component.
    pub fn qname(&self) -> &str {
        self.new
            .as_ref()
            .or(self.old.as_ref())
            .map_or("", |s| s.qname.as_str())
    }
    pub fn file(&self) -> Option<&str> {
        self.new
            .as_ref()
            .or(self.old.as_ref())
            .and_then(|s| s.file.as_deref())
    }
}

/// A removed and an added component with near-identical content.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rename {
    pub kind: Kind,
    pub old: Side,
    pub new: Side,
    /// Similarity of the content, in percent.
    pub score: u32,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Counts {
    pub added: u32,
    pub removed: u32,
    pub changed: u32,
    /// Added, removed or changed components with a breaking change.
    pub breaking: u32,
    /// Changed components whose only changes are documentation.
    pub docs_only: u32,
}

impl Counts {
    fn add(&mut self, d: &ComponentDiff) {
        match d.status {
            Status::Added => self.added += 1,
            Status::Removed => self.removed += 1,
            Status::Changed => self.changed += 1,
        }
        if d.breaking() {
            self.breaking += 1;
        }
        if d.status == Status::Changed && d.impact == Impact::Info {
            self.docs_only += 1;
        }
    }
    pub fn total(&self) -> u32 {
        self.added + self.removed + self.changed
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub total: Counts,
    pub by_kind: BTreeMap<Kind, Counts>,
    /// By target namespace URI (empty string: no namespace); removed
    /// components count under the new URI of a namespace that changed.
    pub by_namespace: BTreeMap<String, Counts>,
    pub by_file: BTreeMap<String, Counts>,
    /// Number of changes of each kind.
    pub changes: BTreeMap<ChangeKind, u32>,
    pub breaking_changes: u32,
    pub possibly_renamed: u32,
}

/// What was compared on one side.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub files: u32,
    /// Target namespaces of the files.
    pub namespaces: Vec<String>,
    /// The `version` attribute of the schema file with the most components.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// The `version` attributes of the schema files.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub versions: Vec<String>,
    /// Global components compared.
    pub components: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaDiff {
    pub format: u32,
    pub generator: String,
    pub options: DiffOptions,
    pub old: SetInfo,
    pub new: SetInfo,
    /// Namespaces that changed between the versions, old URI to new URI.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub namespace_map: BTreeMap<String, String>,
    pub summary: Summary,
    /// Added, removed and changed global components (unchanged ones are left out).
    pub components: Vec<ComponentDiff>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub renames: Vec<Rename>,
}

/// Compare two bundles: `old` is the earlier version. Compact bundles are
/// fine (the effective content models are not used).
pub fn diff(old: &Bundle, new: &Bundle, opts: &DiffOptions) -> SchemaDiff {
    let mut cx = Cx {
        a: old,
        b: new,
        fwd: HashMap::new(),
        ns_map: HashMap::new(),
        opts,
    };
    let ga = globals(old);
    let gb = globals(new);
    let pairs = cx.match_globals(&ga, &gb);
    let matched_b: HashSet<Id> = pairs.iter().map(|p| p.1).collect();
    let mut out = Vec::new();
    for &(o, n, by_local) in &pairs {
        let changes = cx.compare(o, n);
        if changes.is_empty() {
            continue;
        }
        let impact = changes.iter().map(|c| c.impact).min().unwrap();
        let c = &new.components[n as usize];
        out.push(ComponentDiff {
            kind: c.kind,
            status: Status::Changed,
            name: c.name.clone(),
            namespace: ns_uri(new, c.ns).map(str::to_string),
            old: Some(side(old, o)),
            new: Some(side(new, n)),
            by_local_name: by_local,
            impact,
            changes,
            possibly_renamed: None,
        });
    }
    let mut removed = Vec::new();
    for &o in &ga {
        if !cx.fwd.contains_key(&o) {
            removed.push(o);
            let c = &old.components[o as usize];
            out.push(ComponentDiff {
                kind: c.kind,
                status: Status::Removed,
                name: c.name.clone(),
                namespace: ns_uri(old, c.ns).map(str::to_string),
                old: Some(side(old, o)),
                new: None,
                by_local_name: false,
                impact: Impact::Breaking,
                changes: Vec::new(),
                possibly_renamed: None,
            });
        }
    }
    let mut added = Vec::new();
    for &n in &gb {
        if !matched_b.contains(&n) {
            added.push(n);
            let c = &new.components[n as usize];
            out.push(ComponentDiff {
                kind: c.kind,
                status: Status::Added,
                name: c.name.clone(),
                namespace: ns_uri(new, c.ns).map(str::to_string),
                old: None,
                new: Some(side(new, n)),
                by_local_name: false,
                impact: Impact::NonBreaking,
                changes: Vec::new(),
                possibly_renamed: None,
            });
        }
    }
    let renames = if opts.renames {
        cx.renames(&removed, &added)
    } else {
        Vec::new()
    };
    let old_names: HashMap<Id, &str> = renames
        .iter()
        .map(|r| (r.old.id, r.new.qname.as_str()))
        .collect();
    let new_names: HashMap<Id, &str> = renames
        .iter()
        .map(|r| (r.new.id, r.old.qname.as_str()))
        .collect();
    for d in &mut out {
        let found = match d.status {
            Status::Removed => old_names.get(&d.old.as_ref().unwrap().id),
            Status::Added => new_names.get(&d.new.as_ref().unwrap().id),
            Status::Changed => None,
        };
        d.possibly_renamed = found.map(|s| s.to_string());
    }
    out.sort_by(|x, y| {
        (x.qname().to_lowercase(), x.kind, x.status).cmp(&(
            y.qname().to_lowercase(),
            y.kind,
            y.status,
        ))
    });
    // A reference to a type that was renamed does not change documents.
    let pairs: HashSet<(&str, &str)> = renames
        .iter()
        .map(|r| (r.old.qname.as_str(), r.new.qname.as_str()))
        .collect();
    for d in &mut out {
        let mut any = false;
        for c in &mut d.changes {
            if matches!(
                c.kind,
                ChangeKind::TypeChanged
                    | ChangeKind::ChildRetyped
                    | ChangeKind::AttributeRetyped
                    | ChangeKind::BaseChanged
                    | ChangeKind::ItemTypeChanged
            ) && let (Some(a), Some(b)) = (&c.old, &c.new)
                && pairs.contains(&(a.as_str(), b.as_str()))
            {
                c.impact = Impact::NonBreaking;
                any = true;
            }
        }
        if any {
            d.impact = d.changes.iter().map(|c| c.impact).min().unwrap();
        }
    }
    let mut summary = Summary::default();
    for d in &out {
        summary.total.add(d);
        summary.by_kind.entry(d.kind).or_default().add(d);
        summary
            .by_namespace
            .entry(
                d.namespace
                    .as_ref()
                    .map(|u| cx.ns_map.get(u).unwrap_or(u).clone())
                    .unwrap_or_default(),
            )
            .or_default()
            .add(d);
        summary
            .by_file
            .entry(d.file().unwrap_or("").to_string())
            .or_default()
            .add(d);
        for c in &d.changes {
            *summary.changes.entry(c.kind).or_default() += 1;
            if c.impact == Impact::Breaking {
                summary.breaking_changes += 1;
            }
        }
        if d.status == Status::Removed {
            summary.breaking_changes += 1;
        }
    }
    summary.possibly_renamed = renames.len() as u32;
    let namespace_map = cx
        .ns_map
        .iter()
        .filter(|(k, v)| k != v)
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    SchemaDiff {
        format: DIFF_FORMAT,
        generator: format!("schema-explorer-core {}", crate::version()),
        options: opts.clone(),
        old: set_info(old, ga.len()),
        new: set_info(new, gb.len()),
        namespace_map,
        summary,
        components: out,
        renames,
    }
}

const COMPARED: [Kind; 6] = [
    Kind::ComplexType,
    Kind::SimpleType,
    Kind::Element,
    Kind::Attribute,
    Kind::Group,
    Kind::AttributeGroup,
];

fn globals(b: &Bundle) -> Vec<Id> {
    b.components
        .iter()
        .enumerate()
        .filter(|(_, c)| {
            c.parent.is_none() && !c.builtin && c.file.is_some() && COMPARED.contains(&c.kind)
        })
        .map(|(i, _)| i as Id)
        .collect()
}

fn ns_uri(b: &Bundle, ns: Option<NsId>) -> Option<&str> {
    ns.map(|n| b.namespaces[n as usize].uri.as_str())
}

fn side(b: &Bundle, id: Id) -> Side {
    let c = &b.components[id as usize];
    Side {
        id,
        qname: b.qname(id),
        file: c.file.map(|f| b.files[f as usize].name.clone()),
        line: c.line,
    }
}

fn set_info(b: &Bundle, components: usize) -> SetInfo {
    let mut namespaces = BTreeSet::new();
    let mut versions = BTreeSet::new();
    let version = b
        .files
        .iter()
        .filter(|f| f.version.is_some())
        .max_by_key(|f| f.components)
        .and_then(|f| f.version.clone());
    for f in &b.files {
        if let Some(ns) = &f.target_namespace {
            namespaces.insert(ns.clone());
        }
        if let Some(v) = &f.version {
            versions.insert(v.clone());
        }
    }
    SetInfo {
        title: None,
        version,
        files: b.files.len() as u32,
        namespaces: namespaces.into_iter().collect(),
        versions: versions.into_iter().collect(),
        components: components as u32,
    }
}

/// Types share one symbol space.
fn space(k: Kind) -> u8 {
    match k {
        Kind::ComplexType | Kind::SimpleType => 0,
        Kind::Element => 1,
        Kind::Attribute => 2,
        Kind::Group => 3,
        Kind::AttributeGroup => 4,
        _ => 5,
    }
}

fn docs_text(docs: &[Doc]) -> String {
    docs.iter()
        .map(|d| d.text.trim())
        .filter(|t| !t.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn normalize(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn occurs_str(o: Occurs) -> String {
    match o.max {
        Some(m) => format!("{}..{m}", o.min),
        None => format!("{}..*", o.min),
    }
}

/// The occurrence range of a particle inside a compositor that occurs `outer` times.
fn times(outer: Occurs, inner: Occurs) -> Occurs {
    Occurs {
        min: outer.min.saturating_mul(inner.min),
        max: match (outer.max, inner.max) {
            (Some(a), Some(b)) => Some(a.saturating_mul(b)),
            _ => None,
        },
    }
}

/// True when `new` admits fewer occurrences than `old`.
fn tighter(old: Occurs, new: Occurs) -> bool {
    let max_lower = match (old.max, new.max) {
        (None, Some(_)) => true,
        (Some(a), Some(b)) => b < a,
        _ => false,
    };
    new.min > old.min || max_lower
}

struct Cx<'a> {
    a: &'a Bundle,
    b: &'a Bundle,
    /// Matched global components, old id to new id.
    fwd: HashMap<Id, Id>,
    /// Old namespace URI to new namespace URI.
    ns_map: HashMap<String, String>,
    opts: &'a DiffOptions,
}

/// One child particle of a flattened content model.
struct Slot {
    key: String,
    label: String,
    el: Option<Id>,
    /// In effect: multiplied by the compositors around it.
    occurs: Occurs,
    /// Optional in effect: itself, a compositor around it, or a choice.
    optional: bool,
    /// The compositors from the top, e.g. `sequence/choice`.
    cpath: String,
}

#[derive(Clone)]
struct AttrSlot {
    label: String,
    decl: Option<Id>,
    group: bool,
    r#use: AttrUse,
    default: Option<String>,
    fixed: Option<String>,
}

impl<'a> Cx<'a> {
    fn bundle(&self, old: bool) -> &'a Bundle {
        if old { self.a } else { self.b }
    }

    fn comp(&self, old: bool, id: Id) -> &'a Component {
        &self.bundle(old).components[id as usize]
    }

    /// The namespace URI as the new version names it.
    fn uri(&self, old: bool, ns: Option<NsId>) -> String {
        let u = ns_uri(self.bundle(old), ns).unwrap_or("");
        if old {
            self.ns_map.get(u).cloned().unwrap_or_else(|| u.to_string())
        } else {
            u.to_string()
        }
    }

    fn match_globals(&mut self, ga: &[Id], gb: &[Id]) -> Vec<(Id, Id, bool)> {
        let mut by_qname: HashMap<(u8, &str, &str), Id> = HashMap::new();
        for &n in gb {
            let c = self.comp(false, n);
            by_qname.insert(
                (space(c.kind), ns_uri(self.b, c.ns).unwrap_or(""), &c.name),
                n,
            );
        }
        let mut pairs = Vec::new();
        let mut used: HashSet<Id> = HashSet::new();
        for &o in ga {
            let c = self.comp(true, o);
            let k = (
                space(c.kind),
                ns_uri(self.a, c.ns).unwrap_or(""),
                c.name.as_str(),
            );
            if let Some(&n) = by_qname.get(&k)
                && used.insert(n)
            {
                pairs.push((o, n, false));
            }
        }
        for &(o, n, _) in &pairs {
            self.fwd.insert(o, n);
        }
        if self.opts.match_local_names {
            // Unique local names among the unmatched components on both sides.
            let mut left: HashMap<(u8, &str), Vec<Id>> = HashMap::new();
            for &o in ga {
                if !self.fwd.contains_key(&o) {
                    let c = self.comp(true, o);
                    left.entry((space(c.kind), &c.name)).or_default().push(o);
                }
            }
            let mut right: HashMap<(u8, &str), Vec<Id>> = HashMap::new();
            for &n in gb {
                if !used.contains(&n) {
                    let c = self.comp(false, n);
                    right.entry((space(c.kind), &c.name)).or_default().push(n);
                }
            }
            let mut extra = Vec::new();
            for (k, os) in &left {
                if let (Some(ns), [o]) = (right.get(k), os.as_slice())
                    && let [n] = ns.as_slice()
                    && self
                        .comp(true, *o)
                        .ns
                        .map(|x| &self.a.namespaces[x as usize].uri)
                        != self
                            .comp(false, *n)
                            .ns
                            .map(|x| &self.b.namespaces[x as usize].uri)
                {
                    extra.push((*o, *n, true));
                }
            }
            extra.sort();
            // The namespace map: the most frequent counterpart of each old namespace.
            let mut votes: HashMap<(String, String), u32> = HashMap::new();
            for &(o, n, _) in &extra {
                let ou = ns_uri(self.a, self.comp(true, o).ns)
                    .unwrap_or("")
                    .to_string();
                let nu = ns_uri(self.b, self.comp(false, n).ns)
                    .unwrap_or("")
                    .to_string();
                *votes.entry((ou, nu)).or_default() += 1;
            }
            let mut best: HashMap<String, (u32, String)> = HashMap::new();
            for ((ou, nu), v) in votes {
                let e = best.entry(ou).or_insert((0, String::new()));
                if v > e.0 || (v == e.0 && nu < e.1) {
                    *e = (v, nu);
                }
            }
            self.ns_map = best.into_iter().map(|(k, (_, v))| (k, v)).collect();
            for &(o, n, _) in &extra {
                self.fwd.insert(o, n);
            }
            pairs.extend(extra);
        }
        pairs
    }

    /// A key for a reference, the same on both sides when it names the same
    /// (matched) component. Anonymous types give `None`.
    fn ref_key(&self, old: bool, r: &Ref) -> Option<String> {
        match r {
            Ref::Id(id) => {
                let c = self.comp(old, *id);
                if c.parent.is_some() {
                    return None;
                }
                if old && let Some(&n) = self.fwd.get(id) {
                    return self.ref_key(false, &Ref::Id(n));
                }
                Some(format!("{{{}}}{}", self.uri(old, c.ns), c.name))
            }
            Ref::Missing(s) => {
                if old
                    && let Some(rest) = s.strip_prefix('{')
                    && let Some((u, local)) = rest.split_once('}')
                    && let Some(m) = self.ns_map.get(u)
                {
                    return Some(format!("{{{m}}}{local}"));
                }
                Some(s.clone())
            }
        }
    }

    fn label(&self, old: bool, r: &Ref) -> String {
        match r {
            Ref::Id(id) => {
                let c = self.comp(old, *id);
                if c.parent.is_some() && c.kind.is_type() {
                    "(anonymous type)".to_string()
                } else {
                    self.bundle(old).qname(*id)
                }
            }
            Ref::Missing(s) => s.clone(),
        }
    }

    /// The key of an element or attribute declaration (local or global) by
    /// its name and namespace.
    fn decl_key(&self, old: bool, id: Id) -> String {
        let c = self.comp(old, id);
        if c.parent.is_none() {
            return self.ref_key(old, &Ref::Id(id)).unwrap_or_default();
        }
        format!("{{{}}}{}", self.uri(old, c.ns), c.name)
    }

    fn decl_label(&self, old: bool, id: Id) -> String {
        let c = self.comp(old, id);
        if c.parent.is_none() {
            self.bundle(old).qname(id)
        } else {
            c.name.clone()
        }
    }

    fn compare(&self, o: Id, n: Id) -> Vec<Change> {
        let mut out = Vec::new();
        let (co, cn) = (self.comp(true, o), self.comp(false, n));
        self.docs(&co.docs, &cn.docs, "", "", &mut out);
        match cn.kind {
            Kind::ComplexType | Kind::SimpleType => self.types(o, n, "", 0, &mut out),
            Kind::Element => self.element(o, n, "", 0, &mut out),
            Kind::Attribute => self.attribute(o, n, "", 0, &mut out),
            Kind::Group => self.particles(co.group.as_ref(), cn.group.as_ref(), "", 0, &mut out),
            Kind::AttributeGroup => {
                let (x, y) = (
                    co.attribute_group.clone().unwrap_or_default(),
                    cn.attribute_group.clone().unwrap_or_default(),
                );
                self.attrs(
                    (&x.attributes, &x.any_attribute),
                    (&y.attributes, &y.any_attribute),
                    "",
                    0,
                    &mut out,
                );
            }
            _ => {}
        }
        out
    }

    fn docs(&self, o: &[Doc], n: &[Doc], path: &str, subject: &str, out: &mut Vec<Change>) {
        if !self.opts.docs {
            return;
        }
        let (x, y) = (docs_text(o), docs_text(n));
        if normalize(&x) != normalize(&y) {
            out.push(Change {
                kind: ChangeKind::DocsChanged,
                impact: Impact::Info,
                path: path.to_string(),
                subject: subject.to_string(),
                old: (!x.is_empty()).then_some(x),
                new: (!y.is_empty()).then_some(y),
            });
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn push(
        &self,
        out: &mut Vec<Change>,
        kind: ChangeKind,
        impact: Impact,
        path: &str,
        subject: &str,
        old: Option<String>,
        new: Option<String>,
    ) {
        out.push(Change {
            kind,
            impact,
            path: path.to_string(),
            subject: subject.to_string(),
            old,
            new,
        });
    }

    /// Compare type references; anonymous types on both sides are compared
    /// in depth under `path`.
    #[allow(clippy::too_many_arguments)]
    fn type_ref(
        &self,
        o: Option<&Ref>,
        n: Option<&Ref>,
        kind: ChangeKind,
        path: &str,
        subject: &str,
        depth: u32,
        out: &mut Vec<Change>,
    ) {
        let any = Ref::Missing("{http://www.w3.org/2001/XMLSchema}anyType".into());
        let (o, n) = (o.unwrap_or(&any), n.unwrap_or(&any));
        let (ko, kn) = (self.ref_key(true, o), self.ref_key(false, n));
        match (ko, kn) {
            (None, None) => {
                if let (Some(a), Some(b)) = (o.id(), n.id()) {
                    let sub = if subject.is_empty() {
                        path.to_string()
                    } else if path.is_empty() {
                        subject.to_string()
                    } else {
                        format!("{path}/{subject}")
                    };
                    self.types(a, b, &sub, depth + 1, out);
                }
            }
            (x, y) if x == y => {}
            _ => self.push(
                out,
                kind,
                Impact::Breaking,
                path,
                subject,
                Some(self.label(true, o)),
                Some(self.label(false, n)),
            ),
        }
    }

    fn types(&self, o: Id, n: Id, path: &str, depth: u32, out: &mut Vec<Change>) {
        if depth > MAX_DEPTH {
            return;
        }
        let (co, cn) = (self.comp(true, o), self.comp(false, n));
        if depth > 0 {
            self.docs(&co.docs, &cn.docs, path, "", out);
        }
        match (
            &co.complex_type,
            &cn.complex_type,
            &co.simple_type,
            &cn.simple_type,
        ) {
            (Some(x), Some(y), _, _) => self.complex(x, y, path, depth, out),
            (_, _, Some(x), Some(y)) => self.simple(x, y, path, depth, out),
            _ => self.push(
                out,
                ChangeKind::KindChanged,
                Impact::Breaking,
                path,
                "",
                Some(kind_name(co.kind).into()),
                Some(kind_name(cn.kind).into()),
            ),
        }
    }

    fn complex(
        &self,
        x: &ComplexInfo,
        y: &ComplexInfo,
        path: &str,
        depth: u32,
        out: &mut Vec<Change>,
    ) {
        match (&x.derivation, &y.derivation) {
            (None, None) => {}
            (Some(a), Some(b)) => {
                if (a.method, a.simple) != (b.method, b.simple) {
                    self.push(
                        out,
                        ChangeKind::DerivationChanged,
                        Impact::Breaking,
                        path,
                        "",
                        Some(derivation_name(a)),
                        Some(derivation_name(b)),
                    );
                }
                if self.ref_key(true, &a.base) != self.ref_key(false, &b.base) {
                    self.push(
                        out,
                        ChangeKind::BaseChanged,
                        Impact::Breaking,
                        path,
                        "",
                        Some(self.label(true, &a.base)),
                        Some(self.label(false, &b.base)),
                    );
                }
            }
            (a, b) => self.push(
                out,
                ChangeKind::BaseChanged,
                Impact::Breaking,
                path,
                "",
                a.as_ref().map(|d| self.label(true, &d.base)),
                b.as_ref().map(|d| self.label(false, &d.base)),
            ),
        }
        self.flag(
            out,
            ChangeKind::AbstractChanged,
            path,
            x.r#abstract,
            y.r#abstract,
            true,
        );
        self.flag(out, ChangeKind::MixedChanged, path, x.mixed, y.mixed, false);
        self.final_block(out, ChangeKind::FinalChanged, path, &x.r#final, &y.r#final);
        self.final_block(out, ChangeKind::BlockChanged, path, &x.block, &y.block);
        self.particles(x.content.as_ref(), y.content.as_ref(), path, depth, out);
        self.attrs(
            (&x.attributes, &x.any_attribute),
            (&y.attributes, &y.any_attribute),
            path,
            depth,
            out,
        );
        self.facets(&x.facets, &y.facets, path, out);
        self.enums(&x.enumerations, &y.enumerations, path, out);
        for a in x.asserts.iter().filter(|a| !y.asserts.contains(a)) {
            self.push(
                out,
                ChangeKind::AssertRemoved,
                Impact::NonBreaking,
                path,
                a,
                None,
                None,
            );
        }
        for a in y.asserts.iter().filter(|a| !x.asserts.contains(a)) {
            self.push(
                out,
                ChangeKind::AssertAdded,
                Impact::Breaking,
                path,
                a,
                None,
                None,
            );
        }
    }

    /// A boolean flag; `breaking_on` is the new value that breaks documents.
    fn flag(
        &self,
        out: &mut Vec<Change>,
        kind: ChangeKind,
        path: &str,
        x: bool,
        y: bool,
        breaking_on: bool,
    ) {
        if x != y {
            let impact = if y == breaking_on {
                Impact::Breaking
            } else {
                Impact::NonBreaking
            };
            self.push(
                out,
                kind,
                impact,
                path,
                "",
                Some(x.to_string()),
                Some(y.to_string()),
            );
        }
    }

    fn final_block(
        &self,
        out: &mut Vec<Change>,
        kind: ChangeKind,
        path: &str,
        x: &Option<String>,
        y: &Option<String>,
    ) {
        if x != y {
            self.push(
                out,
                kind,
                Impact::NonBreaking,
                path,
                "",
                x.clone(),
                y.clone(),
            );
        }
    }

    fn simple(
        &self,
        x: &SimpleInfo,
        y: &SimpleInfo,
        path: &str,
        depth: u32,
        out: &mut Vec<Change>,
    ) {
        if x.variety != y.variety {
            self.push(
                out,
                ChangeKind::VarietyChanged,
                Impact::Breaking,
                path,
                "",
                Some(format!("{:?}", x.variety).to_lowercase()),
                Some(format!("{:?}", y.variety).to_lowercase()),
            );
            return;
        }
        if x.base.is_some() || y.base.is_some() {
            self.type_ref(
                x.base.as_ref(),
                y.base.as_ref(),
                ChangeKind::BaseChanged,
                path,
                "",
                depth,
                out,
            );
        }
        if x.item.is_some() || y.item.is_some() {
            self.type_ref(
                x.item.as_ref(),
                y.item.as_ref(),
                ChangeKind::ItemTypeChanged,
                path,
                "",
                depth,
                out,
            );
        }
        let ko: Vec<(Option<String>, &Ref)> = x
            .members
            .iter()
            .map(|r| (self.ref_key(true, r), r))
            .collect();
        let kn: Vec<(Option<String>, &Ref)> = y
            .members
            .iter()
            .map(|r| (self.ref_key(false, r), r))
            .collect();
        for (k, r) in &ko {
            if k.is_some() && !kn.iter().any(|(j, _)| j == k) {
                self.push(
                    out,
                    ChangeKind::MemberTypeRemoved,
                    Impact::Breaking,
                    path,
                    &self.label(true, r),
                    None,
                    None,
                );
            }
        }
        for (k, r) in &kn {
            if k.is_some() && !ko.iter().any(|(j, _)| j == k) {
                self.push(
                    out,
                    ChangeKind::MemberTypeAdded,
                    Impact::NonBreaking,
                    path,
                    &self.label(false, r),
                    None,
                    None,
                );
            }
        }
        let anon_o: Vec<Id> = ko
            .iter()
            .filter(|(k, _)| k.is_none())
            .filter_map(|(_, r)| r.id())
            .collect();
        let anon_n: Vec<Id> = kn
            .iter()
            .filter(|(k, _)| k.is_none())
            .filter_map(|(_, r)| r.id())
            .collect();
        for (i, (a, b)) in anon_o.iter().zip(&anon_n).enumerate() {
            self.types(
                *a,
                *b,
                &join(path, &format!("member {}", i + 1)),
                depth + 1,
                out,
            );
        }
        self.facets(&x.facets, &y.facets, path, out);
        self.enums(&x.enumerations, &y.enumerations, path, out);
        self.final_block(out, ChangeKind::FinalChanged, path, &x.r#final, &y.r#final);
    }

    fn enums(&self, x: &[Enumeration], y: &[Enumeration], path: &str, out: &mut Vec<Change>) {
        let nv: HashMap<&str, &Enumeration> = y.iter().map(|e| (e.value.as_str(), e)).collect();
        let ov: HashMap<&str, &Enumeration> = x.iter().map(|e| (e.value.as_str(), e)).collect();
        for e in x {
            match nv.get(e.value.as_str()) {
                None => self.push(
                    out,
                    ChangeKind::EnumerationRemoved,
                    Impact::Breaking,
                    path,
                    &e.value,
                    None,
                    None,
                ),
                Some(f) => self.docs(&e.docs, &f.docs, path, &e.value, out),
            }
        }
        for e in y {
            if !ov.contains_key(e.value.as_str()) {
                // Adding values to an unrestricted type would restrict it.
                let impact = if x.is_empty() {
                    Impact::Breaking
                } else {
                    Impact::NonBreaking
                };
                self.push(
                    out,
                    ChangeKind::EnumerationAdded,
                    impact,
                    path,
                    &e.value,
                    None,
                    None,
                );
            }
        }
    }

    fn facets(&self, x: &[Facet], y: &[Facet], path: &str, out: &mut Vec<Change>) {
        let group = |fs: &[Facet]| {
            let mut m: BTreeMap<String, Vec<String>> = BTreeMap::new();
            for f in fs {
                m.entry(f.kind.clone()).or_default().push(f.value.clone());
            }
            m
        };
        let (gx, gy) = (group(x), group(y));
        let kinds: BTreeSet<&String> = gx.keys().chain(gy.keys()).collect();
        for k in kinds {
            match (gx.get(k), gy.get(k)) {
                (Some(a), None) => self.push(
                    out,
                    ChangeKind::FacetRemoved,
                    Impact::NonBreaking,
                    path,
                    k,
                    Some(a.join(" | ")),
                    None,
                ),
                (None, Some(b)) => self.push(
                    out,
                    ChangeKind::FacetAdded,
                    Impact::Breaking,
                    path,
                    k,
                    None,
                    Some(b.join(" | ")),
                ),
                (Some(a), Some(b)) if a != b => {
                    let impact = facet_impact(k, a, b);
                    self.push(
                        out,
                        ChangeKind::FacetChanged,
                        impact,
                        path,
                        k,
                        Some(a.join(" | ")),
                        Some(b.join(" | ")),
                    );
                }
                _ => {}
            }
        }
    }

    fn element(&self, o: Id, n: Id, path: &str, depth: u32, out: &mut Vec<Change>) {
        let (co, cn) = (self.comp(true, o), self.comp(false, n));
        let (Some(x), Some(y)) = (&co.element, &cn.element) else {
            return;
        };
        self.type_ref(
            x.r#type.as_ref(),
            y.r#type.as_ref(),
            ChangeKind::TypeChanged,
            path,
            "",
            depth,
            out,
        );
        self.flag(
            out,
            ChangeKind::AbstractChanged,
            path,
            x.r#abstract,
            y.r#abstract,
            true,
        );
        self.flag(
            out,
            ChangeKind::NillableChanged,
            path,
            x.nillable,
            y.nillable,
            false,
        );
        if x.default != y.default {
            self.push(
                out,
                ChangeKind::ValueConstraintChanged,
                Impact::NonBreaking,
                path,
                "default",
                x.default.clone(),
                y.default.clone(),
            );
        }
        if x.fixed != y.fixed {
            let impact = if y.fixed.is_some() {
                Impact::Breaking
            } else {
                Impact::NonBreaking
            };
            self.push(
                out,
                ChangeKind::ValueConstraintChanged,
                impact,
                path,
                "fixed",
                x.fixed.clone(),
                y.fixed.clone(),
            );
        }
        self.final_block(out, ChangeKind::FinalChanged, path, &x.r#final, &y.r#final);
        self.final_block(out, ChangeKind::BlockChanged, path, &x.block, &y.block);
        if co.parent.is_some() {
            return;
        }
        // Substitution groups.
        let heads = |old: bool, e: &ElementInfo| -> BTreeMap<String, String> {
            e.substitution_group
                .iter()
                .map(|r| (self.ref_key(old, r).unwrap_or_default(), self.label(old, r)))
                .collect()
        };
        let (ho, hn) = (heads(true, x), heads(false, y));
        if ho.keys().ne(hn.keys()) {
            let lost = ho.keys().any(|k| !hn.contains_key(k));
            let impact = if lost {
                Impact::Breaking
            } else {
                Impact::NonBreaking
            };
            let j = |m: &BTreeMap<String, String>| {
                (!m.is_empty()).then(|| m.values().cloned().collect::<Vec<_>>().join(", "))
            };
            self.push(
                out,
                ChangeKind::SubstitutionGroupChanged,
                impact,
                path,
                "",
                j(&ho),
                j(&hn),
            );
        }
        let members = |old: bool, e: &ElementInfo| -> BTreeMap<String, String> {
            e.members
                .iter()
                .map(|&m| (self.decl_key(old, m), self.bundle(old).qname(m)))
                .collect()
        };
        let (mo, mn) = (members(true, x), members(false, y));
        for (k, l) in &mo {
            if !mn.contains_key(k) {
                self.push(
                    out,
                    ChangeKind::SubstitutionMemberRemoved,
                    Impact::Breaking,
                    path,
                    l,
                    None,
                    None,
                );
            }
        }
        for (k, l) in &mn {
            if !mo.contains_key(k) {
                self.push(
                    out,
                    ChangeKind::SubstitutionMemberAdded,
                    Impact::NonBreaking,
                    path,
                    l,
                    None,
                    None,
                );
            }
        }
    }

    fn attribute(&self, o: Id, n: Id, path: &str, depth: u32, out: &mut Vec<Change>) {
        let (co, cn) = (self.comp(true, o), self.comp(false, n));
        let x = co.attribute.clone().unwrap_or_default();
        let y = cn.attribute.clone().unwrap_or_default();
        self.type_ref(
            x.r#type.as_ref(),
            y.r#type.as_ref(),
            ChangeKind::TypeChanged,
            path,
            "",
            depth,
            out,
        );
        if x.default != y.default {
            self.push(
                out,
                ChangeKind::AttributeDefaultChanged,
                Impact::NonBreaking,
                path,
                "",
                x.default,
                y.default,
            );
        }
        if x.fixed != y.fixed {
            let impact = if y.fixed.is_some() {
                Impact::Breaking
            } else {
                Impact::NonBreaking
            };
            self.push(
                out,
                ChangeKind::AttributeFixedChanged,
                impact,
                path,
                "",
                x.fixed,
                y.fixed,
            );
        }
    }

    fn flatten(
        &self,
        old: bool,
        p: &Particle,
        cpath: &str,
        mul: Occurs,
        out: &mut Vec<Slot>,
        seen: &mut HashMap<String, u32>,
    ) {
        let mut slot = |key: String, label: String, el: Option<Id>, occurs: Occurs| {
            let n = seen.entry(key.clone()).or_default();
            *n += 1;
            let key = if *n > 1 { format!("{key}#{n}") } else { key };
            out.push(Slot {
                key,
                label,
                el,
                occurs: times(mul, occurs),
                optional: mul.min == 0 || occurs.min == 0,
                cpath: cpath.to_string(),
            });
        };
        match p {
            Particle::Element { el, occurs } => {
                let (key, label, id) = match el {
                    Ref::Id(id) => (
                        self.decl_key(old, *id),
                        self.decl_label(old, *id),
                        Some(*id),
                    ),
                    Ref::Missing(_) => (
                        self.ref_key(old, el).unwrap_or_default(),
                        self.label(old, el),
                        None,
                    ),
                };
                slot(key, label, id, *occurs);
            }
            Particle::Group { group, occurs } => {
                let key = format!("group {}", self.ref_key(old, group).unwrap_or_default());
                slot(
                    key,
                    format!("group {}", self.label(old, group)),
                    None,
                    *occurs,
                );
            }
            Particle::Any { wildcard, occurs } => {
                let ns = wildcard.namespace.clone().unwrap_or_else(|| "##any".into());
                slot(format!("any {ns}"), format!("any ({ns})"), None, *occurs);
            }
            Particle::Sequence { items, occurs }
            | Particle::Choice { items, occurs }
            | Particle::All { items, occurs } => {
                let name = compositor(p);
                let sub = if cpath.is_empty() {
                    name.to_string()
                } else {
                    format!("{cpath}/{name}")
                };
                let mut m = times(mul, *occurs);
                if matches!(p, Particle::Choice { .. }) && items.len() > 1 {
                    m.min = 0;
                }
                for i in items {
                    self.flatten(old, i, &sub, m, out, seen);
                }
            }
        }
    }

    fn particles(
        &self,
        x: Option<&Particle>,
        y: Option<&Particle>,
        path: &str,
        depth: u32,
        out: &mut Vec<Change>,
    ) {
        let mut so = Vec::new();
        let mut sn = Vec::new();
        if let Some(p) = x {
            self.flatten(true, p, "", Occurs::default(), &mut so, &mut HashMap::new());
        }
        if let Some(p) = y {
            self.flatten(
                false,
                p,
                "",
                Occurs::default(),
                &mut sn,
                &mut HashMap::new(),
            );
        }
        let (sko, skn) = (
            x.map(skeleton).unwrap_or_default(),
            y.map(skeleton).unwrap_or_default(),
        );
        let mn: HashMap<&str, &Slot> = sn.iter().map(|s| (s.key.as_str(), s)).collect();
        let mo: HashMap<&str, &Slot> = so.iter().map(|s| (s.key.as_str(), s)).collect();
        let mut moved = false;
        let mut items = Vec::new();
        for s in &so {
            let Some(t) = mn.get(s.key.as_str()) else {
                items.push(Change {
                    kind: ChangeKind::ChildRemoved,
                    impact: Impact::Breaking,
                    path: path.to_string(),
                    subject: s.label.clone(),
                    old: Some(occurs_str(s.occurs)),
                    new: None,
                });
                continue;
            };
            if s.cpath != t.cpath {
                moved = true;
                self.push(
                    &mut items,
                    ChangeKind::ChildMoved,
                    Impact::Breaking,
                    path,
                    &t.label,
                    Some(s.cpath.clone()),
                    Some(t.cpath.clone()),
                );
            }
            if s.occurs != t.occurs {
                let impact = if tighter(s.occurs, t.occurs) {
                    Impact::Breaking
                } else {
                    Impact::NonBreaking
                };
                self.push(
                    &mut items,
                    ChangeKind::ChildCardinalityChanged,
                    impact,
                    path,
                    &t.label,
                    Some(occurs_str(s.occurs)),
                    Some(occurs_str(t.occurs)),
                );
            }
            if let (Some(a), Some(b)) = (s.el, t.el) {
                self.child(a, b, path, &t.label, depth, &mut items);
            }
        }
        for t in &sn {
            if !mo.contains_key(t.key.as_str()) {
                let impact = if t.optional {
                    Impact::NonBreaking
                } else {
                    Impact::Breaking
                };
                items.push(Change {
                    kind: ChangeKind::ChildAdded,
                    impact,
                    path: path.to_string(),
                    subject: t.label.clone(),
                    old: None,
                    new: Some(occurs_str(t.occurs)),
                });
            }
        }
        // Order within each sequence.
        let mut seqs: BTreeMap<&str, (Vec<&str>, Vec<&str>)> = BTreeMap::new();
        for s in &so {
            if let Some(t) = mn.get(s.key.as_str())
                && t.cpath == s.cpath
                && s.cpath.ends_with("sequence")
            {
                seqs.entry(&s.cpath).or_default().0.push(&s.key);
            }
        }
        for t in &sn {
            if let Some(s) = mo.get(t.key.as_str())
                && t.cpath == s.cpath
                && t.cpath.ends_with("sequence")
            {
                seqs.entry(&t.cpath).or_default().1.push(&t.key);
            }
        }
        for (a, b) in seqs.values() {
            if a != b {
                let keep = lcs(a, b);
                let label = |k: &str| mn[k].label.clone();
                let off: Vec<String> = b
                    .iter()
                    .filter(|k| !keep.contains(*k))
                    .map(|k| label(k))
                    .collect();
                let lo: Vec<String> = a.iter().map(|k| label(k)).collect();
                let ln: Vec<String> = b.iter().map(|k| label(k)).collect();
                self.push(
                    &mut items,
                    ChangeKind::ChildrenReordered,
                    Impact::Breaking,
                    path,
                    &off.join(", "),
                    Some(lo.join(", ")),
                    Some(ln.join(", ")),
                );
            }
        }
        if sko != skn {
            let impact = if moved
                || top_compositor(&sko) != top_compositor(&skn) && !so.is_empty() && !sn.is_empty()
            {
                Impact::Breaking
            } else {
                Impact::NonBreaking
            };
            out.push(Change {
                kind: ChangeKind::StructureChanged,
                impact,
                path: path.to_string(),
                subject: String::new(),
                old: (!sko.is_empty()).then_some(sko),
                new: (!skn.is_empty()).then_some(skn),
            });
        }
        out.extend(items);
    }

    /// Compare the declarations behind a child present in both versions.
    fn child(&self, a: Id, b: Id, path: &str, label: &str, depth: u32, out: &mut Vec<Change>) {
        let (ca, cb) = (self.comp(true, a), self.comp(false, b));
        // A reference to a global element on both sides: compared on its own.
        if ca.parent.is_none() && cb.parent.is_none() {
            return;
        }
        let sub = join(path, label);
        if ca.parent.is_some() && cb.parent.is_some() {
            self.docs(&ca.docs, &cb.docs, path, label, out);
        }
        let (Some(x), Some(y)) = (&ca.element, &cb.element) else {
            return;
        };
        self.type_ref(
            x.r#type.as_ref(),
            y.r#type.as_ref(),
            ChangeKind::ChildRetyped,
            path,
            label,
            depth,
            out,
        );
        self.flag(
            out,
            ChangeKind::NillableChanged,
            &sub,
            x.nillable,
            y.nillable,
            false,
        );
        if x.fixed != y.fixed {
            let impact = if y.fixed.is_some() {
                Impact::Breaking
            } else {
                Impact::NonBreaking
            };
            self.push(
                out,
                ChangeKind::ValueConstraintChanged,
                impact,
                &sub,
                "fixed",
                x.fixed.clone(),
                y.fixed.clone(),
            );
        }
        if x.default != y.default {
            self.push(
                out,
                ChangeKind::ValueConstraintChanged,
                Impact::NonBreaking,
                &sub,
                "default",
                x.default.clone(),
                y.default.clone(),
            );
        }
    }

    fn attr_slots(&self, old: bool, items: &[AttrItem]) -> Vec<(String, AttrSlot)> {
        items
            .iter()
            .map(|i| match i {
                AttrItem::Attribute {
                    attr,
                    r#use,
                    default,
                    fixed,
                } => {
                    let (key, label, decl) = match attr {
                        Ref::Id(id) => (
                            format!("@{}", self.decl_key(old, *id)),
                            format!("@{}", self.decl_label(old, *id)),
                            Some(*id),
                        ),
                        Ref::Missing(_) => (
                            format!("@{}", self.ref_key(old, attr).unwrap_or_default()),
                            format!("@{}", self.label(old, attr)),
                            None,
                        ),
                    };
                    let dd = decl.and_then(|d| self.comp(old, d).attribute.as_ref());
                    (
                        key,
                        AttrSlot {
                            label,
                            decl,
                            group: false,
                            r#use: *r#use,
                            default: default
                                .clone()
                                .or_else(|| dd.and_then(|a| a.default.clone())),
                            fixed: fixed.clone().or_else(|| dd.and_then(|a| a.fixed.clone())),
                        },
                    )
                }
                AttrItem::Group { group } => (
                    format!("group {}", self.ref_key(old, group).unwrap_or_default()),
                    AttrSlot {
                        label: format!("attributeGroup {}", self.label(old, group)),
                        decl: group.id(),
                        group: true,
                        r#use: AttrUse::Optional,
                        default: None,
                        fixed: None,
                    },
                ),
            })
            .collect()
    }

    /// Whether an attribute group (new version) has a required attribute.
    fn group_required(&self, id: Id) -> bool {
        self.comp(false, id)
            .attribute_group
            .as_ref()
            .is_some_and(|g| {
                g.attributes.iter().any(|a| {
                    matches!(
                        a,
                        AttrItem::Attribute {
                            r#use: AttrUse::Required,
                            ..
                        }
                    )
                })
            })
    }

    #[allow(clippy::type_complexity)]
    fn attrs(
        &self,
        x: (&[AttrItem], &Option<Wildcard>),
        y: (&[AttrItem], &Option<Wildcard>),
        path: &str,
        depth: u32,
        out: &mut Vec<Change>,
    ) {
        let so = self.attr_slots(true, x.0);
        let sn = self.attr_slots(false, y.0);
        let mn: HashMap<&str, &AttrSlot> = sn.iter().map(|(k, s)| (k.as_str(), s)).collect();
        let mo: HashMap<&str, &AttrSlot> = so.iter().map(|(k, s)| (k.as_str(), s)).collect();
        for (k, s) in &so {
            let Some(t) = mn.get(k.as_str()) else {
                self.push(
                    out,
                    ChangeKind::AttributeRemoved,
                    Impact::Breaking,
                    path,
                    &s.label,
                    Some(use_name(s.r#use).into()),
                    None,
                );
                continue;
            };
            if s.group {
                continue;
            }
            let label = &t.label;
            if s.r#use != t.r#use {
                let impact = if t.r#use == AttrUse::Optional {
                    Impact::NonBreaking
                } else {
                    Impact::Breaking
                };
                self.push(
                    out,
                    ChangeKind::AttributeUseChanged,
                    impact,
                    path,
                    label,
                    Some(use_name(s.r#use).into()),
                    Some(use_name(t.r#use).into()),
                );
            }
            if s.default != t.default {
                self.push(
                    out,
                    ChangeKind::AttributeDefaultChanged,
                    Impact::NonBreaking,
                    path,
                    label,
                    s.default.clone(),
                    t.default.clone(),
                );
            }
            if s.fixed != t.fixed {
                let impact = if t.fixed.is_some() {
                    Impact::Breaking
                } else {
                    Impact::NonBreaking
                };
                self.push(
                    out,
                    ChangeKind::AttributeFixedChanged,
                    impact,
                    path,
                    label,
                    s.fixed.clone(),
                    t.fixed.clone(),
                );
            }
            if let (Some(a), Some(b)) = (s.decl, t.decl) {
                let (ca, cb) = (self.comp(true, a), self.comp(false, b));
                if ca.parent.is_some() || cb.parent.is_some() {
                    if ca.parent.is_some() && cb.parent.is_some() {
                        self.docs(&ca.docs, &cb.docs, path, label, out);
                    }
                    let (ta, tb) = (
                        ca.attribute.as_ref().and_then(|i| i.r#type.as_ref()),
                        cb.attribute.as_ref().and_then(|i| i.r#type.as_ref()),
                    );
                    self.type_ref(
                        ta,
                        tb,
                        ChangeKind::AttributeRetyped,
                        path,
                        label,
                        depth,
                        out,
                    );
                }
            }
        }
        for (k, t) in &sn {
            if !mo.contains_key(k.as_str()) {
                let required = if t.group {
                    t.decl.is_some_and(|g| self.group_required(g))
                } else {
                    t.r#use == AttrUse::Required
                };
                let impact = if required {
                    Impact::Breaking
                } else {
                    Impact::NonBreaking
                };
                self.push(
                    out,
                    ChangeKind::AttributeAdded,
                    impact,
                    path,
                    &t.label,
                    None,
                    Some(use_name(t.r#use).into()),
                );
            }
        }
        if x.1 != y.1 {
            let impact = if y.1.is_none() {
                Impact::Breaking
            } else if x.1.is_none() {
                Impact::NonBreaking
            } else {
                Impact::Breaking
            };
            let w = |w: &Option<Wildcard>| w.as_ref().map(wildcard_str);
            self.push(
                out,
                ChangeKind::AnyAttributeChanged,
                impact,
                path,
                "",
                w(x.1),
                w(y.1),
            );
        }
    }

    /// Pair removed and added components with near-identical content.
    fn renames(&self, removed: &[Id], added: &[Id]) -> Vec<Rename> {
        let tokens = |old: bool, id: Id| -> (Kind, BTreeSet<String>, String) {
            let c = self.comp(old, id);
            let mut t = BTreeSet::new();
            let local = |r: &Ref, pre: &str| {
                let s = self.label(old, r);
                let n = s.rsplit(':').next().unwrap_or(&s).to_string();
                format!("{pre}{n}")
            };
            if let Some(ct) = &c.complex_type {
                if let Some(d) = &ct.derivation {
                    t.insert(local(&d.base, "base "));
                }
                let mut slots = Vec::new();
                if let Some(p) = &ct.content {
                    self.flatten(
                        old,
                        p,
                        "",
                        Occurs::default(),
                        &mut slots,
                        &mut HashMap::new(),
                    );
                }
                for s in slots {
                    t.insert(format!(
                        "child {}",
                        s.label.rsplit(':').next().unwrap_or(&s.label)
                    ));
                }
                for (_, s) in self.attr_slots(old, &ct.attributes) {
                    t.insert(s.label.rsplit(':').next().unwrap_or(&s.label).to_string());
                }
                for e in &ct.enumerations {
                    t.insert(format!("enum {}", e.value));
                }
            }
            if let Some(st) = &c.simple_type {
                if let Some(b) = &st.base {
                    t.insert(local(b, "base "));
                }
                for e in &st.enumerations {
                    t.insert(format!("enum {}", e.value));
                }
                for f in &st.facets {
                    t.insert(format!("{} {}", f.kind, f.value));
                }
            }
            if let Some(g) = &c.group {
                let mut slots = Vec::new();
                self.flatten(
                    old,
                    g,
                    "",
                    Occurs::default(),
                    &mut slots,
                    &mut HashMap::new(),
                );
                for s in slots {
                    t.insert(format!(
                        "child {}",
                        s.label.rsplit(':').next().unwrap_or(&s.label)
                    ));
                }
            }
            if let Some(ag) = &c.attribute_group {
                for (_, s) in self.attr_slots(old, &ag.attributes) {
                    t.insert(s.label.rsplit(':').next().unwrap_or(&s.label).to_string());
                }
            }
            if let Some(e) = &c.element
                && let Some(r) = &e.r#type
            {
                t.insert(local(r, "type "));
            }
            if let Some(a) = &c.attribute
                && let Some(r) = &a.r#type
            {
                t.insert(local(r, "type "));
            }
            (c.kind, t, normalize(&docs_text(&c.docs)))
        };
        let ra: Vec<(Id, Tokens)> = removed.iter().map(|&o| (o, tokens(true, o))).collect();
        let rb: Vec<(Id, Tokens)> = added.iter().map(|&n| (n, tokens(false, n))).collect();
        let mut cands = Vec::new();
        for (o, (ko, to, dox)) in &ra {
            for (n, (kn, tn, doy)) in &rb {
                if ko != kn {
                    continue;
                }
                let inter = to.intersection(tn).count();
                let uni = to.union(tn).count();
                let score = (100 * inter).checked_div(uni).unwrap_or(0) as u32;
                let same_docs = !dox.is_empty() && dox == doy;
                let ok = (score >= 80 && to.len().min(tn.len()) >= 3)
                    || (same_docs && score >= 50)
                    || (same_docs && uni == 0);
                if ok {
                    let s = if same_docs { score.max(90) } else { score };
                    cands.push((s, *o, *n));
                }
            }
        }
        cands.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)).then(a.2.cmp(&b.2)));
        let (mut uo, mut un) = (HashSet::new(), HashSet::new());
        let mut out = Vec::new();
        for (score, o, n) in cands {
            if uo.contains(&o) || un.contains(&n) {
                continue;
            }
            uo.insert(o);
            un.insert(n);
            out.push(Rename {
                kind: self.comp(false, n).kind,
                old: side(self.a, o),
                new: side(self.b, n),
                score,
            });
        }
        out.sort_by(|a, b| a.old.qname.cmp(&b.old.qname));
        out
    }
}

/// Kind, content tokens and documentation of a component, to spot renames.
type Tokens = (Kind, BTreeSet<String>, String);

fn join(path: &str, name: &str) -> String {
    if path.is_empty() {
        name.to_string()
    } else {
        format!("{path}/{name}")
    }
}

fn compositor(p: &Particle) -> &'static str {
    match p {
        Particle::Sequence { .. } => "sequence",
        Particle::Choice { .. } => "choice",
        Particle::All { .. } => "all",
        _ => "",
    }
}

/// The compositors of a content model, leaves left out:
/// `sequence(choice[0..1](), sequence())`.
fn skeleton(p: &Particle) -> String {
    match p {
        Particle::Sequence { items, occurs }
        | Particle::Choice { items, occurs }
        | Particle::All { items, occurs } => {
            let mut leaves = 0;
            p.walk(&mut |q| {
                if matches!(
                    q,
                    Particle::Element { .. } | Particle::Group { .. } | Particle::Any { .. }
                ) {
                    leaves += 1;
                }
            });
            if leaves == 0 {
                return String::new();
            }
            let inner: Vec<String> = items
                .iter()
                .map(skeleton)
                .filter(|s| !s.is_empty())
                .collect();
            let occ = if *occurs == Occurs::default() {
                String::new()
            } else {
                format!("[{}]", occurs_str(*occurs))
            };
            format!("{}{occ}({})", compositor(p), inner.join(", "))
        }
        _ => String::new(),
    }
}

fn top_compositor(s: &str) -> &str {
    s.split(['(', '[']).next().unwrap_or("")
}

fn lcs<'a>(a: &[&'a str], b: &[&'a str]) -> HashSet<&'a str> {
    let (n, m) = (a.len(), b.len());
    let mut t = vec![vec![0u32; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            t[i][j] = if a[i] == b[j] {
                t[i + 1][j + 1] + 1
            } else {
                t[i + 1][j].max(t[i][j + 1])
            };
        }
    }
    let (mut i, mut j) = (0, 0);
    let mut out = HashSet::new();
    while i < n && j < m {
        if a[i] == b[j] {
            out.insert(a[i]);
            i += 1;
            j += 1;
        } else if t[i + 1][j] >= t[i][j + 1] {
            i += 1;
        } else {
            j += 1;
        }
    }
    out
}

fn facet_impact(kind: &str, a: &[String], b: &[String]) -> Impact {
    let num = |v: &[String]| -> Option<f64> {
        match v {
            [x] => x.trim().parse().ok(),
            _ => None,
        }
    };
    let (Some(x), Some(y)) = (num(a), num(b)) else {
        return Impact::Breaking;
    };
    let tighter = match kind {
        "minLength" | "minInclusive" | "minExclusive" => y > x,
        "maxLength" | "maxInclusive" | "maxExclusive" | "totalDigits" | "fractionDigits" => y < x,
        _ => true,
    };
    if tighter {
        Impact::Breaking
    } else {
        Impact::NonBreaking
    }
}

fn wildcard_str(w: &Wildcard) -> String {
    let mut s = w.namespace.clone().unwrap_or_else(|| "##any".into());
    if let Some(n) = &w.not_namespace {
        s = format!("not {n}");
    }
    if let Some(p) = &w.process_contents {
        s.push_str(&format!(" ({p})"));
    }
    s
}

fn use_name(u: AttrUse) -> &'static str {
    match u {
        AttrUse::Optional => "optional",
        AttrUse::Required => "required",
        AttrUse::Prohibited => "prohibited",
    }
}

fn derivation_name(d: &Derivation) -> String {
    let m = match d.method {
        Method::Extension => "extension",
        Method::Restriction => "restriction",
    };
    format!(
        "{m} ({} content)",
        if d.simple { "simple" } else { "complex" }
    )
}

/// The XSD name of a kind: `complexType`, `element`, ...
pub fn kind_name(k: Kind) -> &'static str {
    match k {
        Kind::Element => "element",
        Kind::ComplexType => "complexType",
        Kind::SimpleType => "simpleType",
        Kind::Attribute => "attribute",
        Kind::AttributeGroup => "attributeGroup",
        Kind::Group => "group",
        Kind::Key => "key",
        Kind::Keyref => "keyref",
        Kind::Unique => "unique",
    }
}

/// A readable label of a change kind: "child added", ...
pub fn change_label(k: ChangeKind) -> &'static str {
    use ChangeKind::*;
    match k {
        KindChanged => "kind changed",
        BaseChanged => "base type changed",
        DerivationChanged => "derivation changed",
        AbstractChanged => "abstract changed",
        FinalChanged => "final changed",
        BlockChanged => "block changed",
        MixedChanged => "mixed changed",
        NillableChanged => "nillable changed",
        TypeChanged => "type changed",
        ValueConstraintChanged => "value constraint changed",
        SubstitutionGroupChanged => "substitution group changed",
        SubstitutionMemberAdded => "substitution member added",
        SubstitutionMemberRemoved => "substitution member removed",
        ChildAdded => "child added",
        ChildRemoved => "child removed",
        ChildRetyped => "child retyped",
        ChildCardinalityChanged => "cardinality changed",
        ChildrenReordered => "children reordered",
        ChildMoved => "child moved",
        StructureChanged => "structure changed",
        AttributeAdded => "attribute added",
        AttributeRemoved => "attribute removed",
        AttributeRetyped => "attribute retyped",
        AttributeUseChanged => "attribute use changed",
        AttributeDefaultChanged => "attribute default changed",
        AttributeFixedChanged => "attribute fixed value changed",
        AnyAttributeChanged => "anyAttribute changed",
        EnumerationAdded => "enumeration value added",
        EnumerationRemoved => "enumeration value removed",
        FacetAdded => "facet added",
        FacetRemoved => "facet removed",
        FacetChanged => "facet changed",
        VarietyChanged => "variety changed",
        ItemTypeChanged => "list item type changed",
        MemberTypeAdded => "union member added",
        MemberTypeRemoved => "union member removed",
        AssertAdded => "assertion added",
        AssertRemoved => "assertion removed",
        DocsChanged => "documentation changed",
    }
}
