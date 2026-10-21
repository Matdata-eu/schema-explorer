//! The bundle: one XSD or JSON Schema set read into components with small integer ids, plus
//! the indexes the viewer needs ("where used", derived types, substitution
//! group members, effective content models, search), as serde JSON.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Bundle format version. Bump when the viewer must change to read it.
pub const FORMAT: u32 = 1;

/// Index into [`Bundle::components`].
pub type Id = u32;
/// Index into [`Bundle::files`].
pub type FileId = u32;
/// Index into [`Bundle::namespaces`].
pub type NsId = u32;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bundle {
    pub format: u32,
    pub generator: String,
    /// The schema language the set was read from.
    #[serde(default, skip_serializing_if = "Language::is_xsd")]
    pub language: Language,
    /// True when the bundle was written in the compact form: no
    /// `effective` content models and no `search` index (the viewer
    /// recomputes them).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub compact: bool,
    pub files: Vec<FileInfo>,
    pub namespaces: Vec<Namespace>,
    /// Component ids are indexes into this vector.
    pub components: Vec<Component>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub diagnostics: Vec<Diagnostic>,
    pub stats: Stats,
    /// Lower-case search terms (names, name parts, words of the
    /// documentation and enumeration values) to the components they occur in.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub search: BTreeMap<String, Vec<Id>>,
}

/// The schema language of a bundle.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Language {
    /// XML Schema (XSD).
    #[default]
    Xsd,
    /// JSON Schema, including the schemas of OpenAPI and AsyncAPI documents.
    /// Named schemas are complex or simple types, properties are local
    /// elements; [`Component::json`] says what they are in JSON terms.
    JsonSchema,
}

impl Language {
    pub fn is_xsd(&self) -> bool {
        *self == Language::Xsd
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    /// Path of the file, relative to the common directory of all files.
    pub name: String,
    /// The `targetNamespace` attribute.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_namespace: Option<String>,
    /// The namespace the components of the file are in: the target
    /// namespace, or that of the including schema for a chameleon include.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub namespace: Option<NsId>,
    /// Prefixes declared on the `xs:schema` element.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub prefixes: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// The schema language and version of a JSON file: `JSON Schema
    /// 2020-12`, `OpenAPI 3.1.0`, `AsyncAPI 3.0.0`, ...
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dialect: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub element_form_qualified: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub attribute_form_qualified: bool,
    /// True when the file was given as input, false when it was pulled in
    /// through an import or include.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub input: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub directives: Vec<Directive>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub docs: Vec<Doc>,
    /// Number of global components declared in the file.
    pub components: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DirectiveKind {
    Import,
    Include,
    Redefine,
    Override,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Directive {
    pub kind: DirectiveKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub namespace: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    /// The file it resolved to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file: Option<FileId>,
    /// How it was resolved when not by its location: `namespace` (another
    /// input file has the imported namespace), `filename` (an input file has
    /// the same file name) or `builtin` (the XML namespace).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub via: Option<String>,
    pub line: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Namespace {
    pub uri: String,
    /// Prefix for display, unique in the bundle.
    pub prefix: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Element,
    ComplexType,
    SimpleType,
    Attribute,
    AttributeGroup,
    Group,
    Key,
    Keyref,
    Unique,
}

impl Kind {
    pub fn is_type(self) -> bool {
        matches!(self, Kind::ComplexType | Kind::SimpleType)
    }
    pub fn is_identity(self) -> bool {
        matches!(self, Kind::Key | Kind::Keyref | Kind::Unique)
    }
}

/// A reference to a component: its id, or `{ns}local` when it was not
/// found (the diagnostics say why).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Ref {
    Id(Id),
    Missing(String),
}

impl Ref {
    pub fn id(&self) -> Option<Id> {
        match self {
            Ref::Id(id) => Some(*id),
            Ref::Missing(_) => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Component {
    pub kind: Kind,
    /// Local name; empty for an anonymous type.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ns: Option<NsId>,
    /// The enclosing component of a local declaration or anonymous type;
    /// none for a global one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<Id>,
    /// None for the built-in types of XML Schema and the XML namespace.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file: Option<FileId>,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub line: u32,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub docs: Vec<Doc>,
    /// Content of `xs:appinfo`, as XML text.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub appinfo: Vec<String>,
    /// The global component this one redefines (`xs:redefine` / `xs:override`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub redefines: Option<Id>,
    /// Who references this component.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub used_by: Vec<Usage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub element: Option<ElementInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub complex_type: Option<ComplexInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub simple_type: Option<SimpleInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attribute: Option<AttributeInfo>,
    /// Model group definition: its particle.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<Particle>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attribute_group: Option<AttributeGroupInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity: Option<IdentityInfo>,
    /// A built-in type or attribute (no source file).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub builtin: bool,
    /// JSON Schema details, for a bundle read from JSON Schema.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub json: Option<Box<JsonInfo>>,
}

/// What a component is in JSON Schema terms.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JsonInfo {
    /// For a type: the JSON value it describes (`object`, `array`,
    /// `string`, `number`, `integer`, `boolean`, `null`, `any`) or how it
    /// combines schemas (`oneOf`, `anyOf`, `union`). For a local element:
    /// its role (`property`, `patternProperty`, `additionalProperties`,
    /// `items`, `option`).
    pub kind: String,
    /// JSON pointer of the schema in its file.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub pointer: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// `examples` and `example`, as JSON text.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub examples: Vec<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub deprecated: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub read_only: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub write_only: bool,
    /// A property whose value is an array: the element has the item type,
    /// and its cardinality comes from `minItems`/`maxItems`.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub array: bool,
}

impl Component {
    pub fn new(kind: Kind, name: String) -> Component {
        Component {
            kind,
            name,
            ns: None,
            parent: None,
            file: None,
            line: 0,
            docs: Vec::new(),
            appinfo: Vec::new(),
            redefines: None,
            used_by: Vec::new(),
            element: None,
            complex_type: None,
            simple_type: None,
            attribute: None,
            group: None,
            attribute_group: None,
            identity: None,
            builtin: false,
            json: None,
        }
    }
    pub fn is_global(&self) -> bool {
        self.parent.is_none()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Doc {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lang: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    pub text: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UseKind {
    /// `type=` of an element or attribute.
    Type,
    /// `base=` of an extension or restriction.
    Base,
    /// `itemType=` of a list.
    Item,
    /// A member type of a union.
    Member,
    /// `ref=` to a global element.
    Element,
    /// `ref=` to a global attribute.
    Attribute,
    /// `ref=` to a model group.
    Group,
    /// `ref=` to an attribute group.
    AttributeGroup,
    /// `substitutionGroup=` naming the head element.
    Substitution,
    /// `refer=` of a keyref.
    Refer,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    /// The referencing component (a local one has a `parent` chain up to
    /// the global component).
    pub by: Id,
    pub how: UseKind,
}

fn is_zero(n: &u32) -> bool {
    *n == 0
}
fn one() -> u32 {
    1
}
fn is_one(n: &u32) -> bool {
    *n == 1
}
fn some_one() -> Option<u32> {
    Some(1)
}
fn is_some_one(n: &Option<u32>) -> bool {
    *n == Some(1)
}

/// `minOccurs`/`maxOccurs`; `max: null` means unbounded, absent means 1.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Occurs {
    #[serde(default = "one", skip_serializing_if = "is_one")]
    pub min: u32,
    #[serde(default = "some_one", skip_serializing_if = "is_some_one")]
    pub max: Option<u32>,
}

impl Default for Occurs {
    fn default() -> Self {
        Occurs {
            min: 1,
            max: Some(1),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum Particle {
    /// A local element declaration or a reference to a global one.
    Element {
        el: Ref,
        #[serde(flatten)]
        occurs: Occurs,
    },
    /// A reference to a model group.
    Group {
        group: Ref,
        #[serde(flatten)]
        occurs: Occurs,
    },
    Sequence {
        items: Vec<Particle>,
        #[serde(flatten)]
        occurs: Occurs,
    },
    Choice {
        items: Vec<Particle>,
        #[serde(flatten)]
        occurs: Occurs,
    },
    All {
        items: Vec<Particle>,
        #[serde(flatten)]
        occurs: Occurs,
    },
    Any {
        #[serde(flatten)]
        wildcard: Wildcard,
        #[serde(flatten)]
        occurs: Occurs,
    },
}

impl Particle {
    pub fn occurs(&self) -> Occurs {
        match self {
            Particle::Element { occurs, .. }
            | Particle::Group { occurs, .. }
            | Particle::Sequence { occurs, .. }
            | Particle::Choice { occurs, .. }
            | Particle::All { occurs, .. }
            | Particle::Any { occurs, .. } => *occurs,
        }
    }

    /// Calls `f` on this particle and every nested one.
    pub fn walk<'a>(&'a self, f: &mut impl FnMut(&'a Particle)) {
        f(self);
        if let Particle::Sequence { items, .. }
        | Particle::Choice { items, .. }
        | Particle::All { items, .. } = self
        {
            for p in items {
                p.walk(f);
            }
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Wildcard {
    /// The `namespace` attribute (`##any` when absent).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub namespace: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub not_namespace: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process_contents: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Constraint {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fixed: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ElementInfo {
    /// The declared type (named, built-in or anonymous). None when the
    /// declaration has neither: the type is that of the substitution group
    /// head, or `xs:anyType`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#type: Option<Ref>,
    /// Substitution group heads (one in XSD 1.0).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub substitution_group: Vec<Ref>,
    /// Elements whose substitution group names this one (direct members).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub members: Vec<Id>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub r#abstract: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub nillable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fixed: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#final: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub block: Option<String>,
    /// Identity constraints (key, keyref, unique) declared on the element.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub identity: Vec<Id>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Method {
    Extension,
    Restriction,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Derivation {
    pub method: Method,
    pub base: Ref,
    /// True for `xs:simpleContent`.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub simple: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComplexInfo {
    /// None for a type that restricts `xs:anyType` implicitly.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub derivation: Option<Derivation>,
    /// The particle declared by this type itself (for an extension: only
    /// what it adds to the base).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<Particle>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attributes: Vec<AttrItem>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub any_attribute: Option<Wildcard>,
    /// Facets of a `xs:simpleContent` restriction.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub facets: Vec<Facet>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub enumerations: Vec<Enumeration>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub mixed: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub r#abstract: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#final: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub block: Option<String>,
    /// XSD 1.1 `xs:assert` tests.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub asserts: Vec<String>,
    /// Types that name this one as their base (both complex and simple).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub derived: Vec<Id>,
    /// The effective content model, inheritance included.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effective: Option<Effective>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AttrUse {
    #[default]
    Optional,
    Required,
    Prohibited,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum AttrItem {
    /// A local attribute declaration or a reference to a global one.
    Attribute {
        attr: Ref,
        #[serde(default, skip_serializing_if = "is_optional")]
        r#use: AttrUse,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        default: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        fixed: Option<String>,
    },
    /// A reference to an attribute group.
    Group { group: Ref },
}

fn is_optional(u: &AttrUse) -> bool {
    *u == AttrUse::Optional
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Effective {
    /// The types whose own `content` particles, in this order, make up the
    /// content model (a sequence of them). Empty for empty or simple content.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub content: Vec<Id>,
    /// All attributes, inherited and from attribute groups (expanded).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attributes: Vec<EffectiveAttr>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub any_attribute: Option<Wildcard>,
    /// The simple type of the text content, for simple content.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub simple: Option<Ref>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub mixed: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveAttr {
    pub attr: Ref,
    #[serde(default, skip_serializing_if = "is_optional")]
    pub r#use: AttrUse,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fixed: Option<String>,
    /// The type that declares it.
    pub from: Id,
    /// The attribute group it comes through, if any (the outermost one).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub via: Option<Id>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Variety {
    Atomic,
    List,
    Union,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SimpleInfo {
    pub variety: Variety,
    /// Restriction base.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base: Option<Ref>,
    /// List item type.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item: Option<Ref>,
    /// Union member types.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub members: Vec<Ref>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub facets: Vec<Facet>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub enumerations: Vec<Enumeration>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#final: Option<String>,
    /// Types that name this one as their base.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub derived: Vec<Id>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Facet {
    /// Facet element name: `pattern`, `maxLength`, `minInclusive`, ...
    pub kind: String,
    pub value: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub fixed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Enumeration {
    pub value: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub docs: Vec<Doc>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub appinfo: Vec<String>,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub line: u32,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttributeInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#type: Option<Ref>,
    /// Value constraint on the declaration (global ones; local uses carry
    /// theirs in [`AttrItem`]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fixed: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub inheritable: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttributeGroupInfo {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attributes: Vec<AttrItem>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub any_attribute: Option<Wildcard>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityInfo {
    pub selector: String,
    pub fields: Vec<String>,
    /// For a keyref: the key or unique constraint it refers to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refer: Option<Ref>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Level {
    Info,
    Warning,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    pub level: Level,
    /// Stable machine-readable code: `parse-error`, `unresolved-import`,
    /// `unresolved-ref`, `duplicate`, `cycle`, ...
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file: Option<FileId>,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub line: u32,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub files: u32,
    /// Global components per kind.
    pub global: BTreeMap<Kind, u32>,
    /// Local declarations and anonymous types per kind.
    pub local: BTreeMap<Kind, u32>,
    pub enumerations: u32,
    pub unresolved_imports: u32,
    pub unresolved_refs: u32,
}

impl Bundle {
    /// The display name `prefix:name` of a component.
    pub fn qname(&self, id: Id) -> String {
        let c = &self.components[id as usize];
        match c.ns {
            Some(ns) => format!("{}:{}", self.namespaces[ns as usize].prefix, c.name),
            None => c.name.clone(),
        }
    }

    /// The global component of `kind` with display name `qname` (`prefix:name`,
    /// or a bare name for no namespace).
    pub fn find(&self, kind: Kind, qname: &str) -> Option<Id> {
        let (prefix, name) = match qname.split_once(':') {
            Some((p, n)) => (Some(p), n),
            None => (None, qname),
        };
        let ns = match prefix {
            Some(p) => Some(self.namespaces.iter().position(|n| n.prefix == p)? as NsId),
            None => None,
        };
        self.components
            .iter()
            .position(|c| c.kind == kind && c.parent.is_none() && c.ns == ns && c.name == name)
            .map(|i| i as Id)
    }

    /// Strip the parts the viewer can recompute (effective content models
    /// and the search index) to make big bundles smaller.
    pub fn make_compact(&mut self) {
        self.compact = true;
        self.search.clear();
        for c in &mut self.components {
            if let Some(ct) = &mut c.complex_type {
                ct.effective = None;
            }
        }
    }

    pub fn unresolved_imports(&self) -> impl Iterator<Item = &Diagnostic> {
        self.diagnostics
            .iter()
            .filter(|d| d.code == "unresolved-import")
    }
}
