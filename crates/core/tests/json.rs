//! Tests of the JSON Schema reader on the hand-written sets in
//! tests/data/json: cross-file `$ref` (JSON to YAML), `$anchor`, `allOf`
//! inheritance, `oneOf` choices, enumerations, drafts 04 and 2020-12,
//! OpenAPI and AsyncAPI documents, and a comparison of two versions.

use schema_explorer_core::bundle::{Bundle, Kind, Language, Particle, Ref, Variety};
use schema_explorer_core::diff::*;
use schema_explorer_core::{Options, Source, index};
use std::path::Path;

fn load(files: &[&str]) -> Bundle {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/data/json");
    index(
        files
            .iter()
            .map(|f| Source::new(*f, std::fs::read(dir.join(f)).unwrap()))
            .collect(),
        None,
        &Options::default(),
    )
}

fn order(version: &str) -> Bundle {
    load(&[
        &format!("{version}/order.schema.json"),
        &format!("{version}/customer.yaml"),
    ])
}

/// The names and cardinalities (`name min..max`) of the elements of a content model.
fn children(b: &Bundle, p: &Particle) -> Vec<String> {
    let mut out = Vec::new();
    p.walk(&mut |p| {
        if let Particle::Element {
            el: Ref::Id(e),
            occurs,
        } = p
        {
            out.push(format!(
                "{} {}..{}",
                b.components[*e as usize].name,
                occurs.min,
                occurs.max.map_or("*".to_string(), |m| m.to_string())
            ));
        }
    });
    out
}

fn type_name(b: &Bundle, el: u32) -> String {
    match b.components[el as usize]
        .element
        .as_ref()
        .unwrap()
        .r#type
        .as_ref()
        .unwrap()
    {
        Ref::Id(t) => b.qname(*t),
        Ref::Missing(m) => format!("missing {m}"),
    }
}

fn child(b: &Bundle, ty: u32, name: &str) -> u32 {
    let mut found = None;
    b.components[ty as usize]
        .complex_type
        .as_ref()
        .unwrap()
        .content
        .as_ref()
        .unwrap()
        .walk(&mut |p| {
            if let Particle::Element { el: Ref::Id(e), .. } = p
                && b.components[*e as usize].name == name
            {
                found = Some(*e);
            }
        });
    found.unwrap_or_else(|| panic!("no {name}"))
}

#[test]
fn draft_2020_set() {
    let b = order("v1");
    assert_eq!(b.language, Language::JsonSchema);
    assert_eq!(b.files[0].dialect.as_deref(), Some("JSON Schema 2020-12"));
    // Root schemas and $defs are global types; no namespaces when names are unique.
    assert!(b.namespaces.is_empty());
    let o = b.find(Kind::ComplexType, "order").expect("root type");
    let ct = b.components[o as usize].complex_type.as_ref().unwrap();
    assert_eq!(
        children(&b, ct.content.as_ref().unwrap()),
        [
            "id 1..1",
            "customer 1..1",
            "lines 1..50",
            "status 0..1",
            "payment 0..1",
            "note 0..1",
            "tags 0..1",
            "extra 0..1"
        ]
    );
    assert!(
        ct.facets
            .iter()
            .any(|f| f.kind == "additionalProperties" && f.value == "false")
    );
    assert_eq!(b.components[o as usize].docs[0].text, "A customer order.");
    // Cross-file $ref into YAML, array items, $anchor.
    assert_eq!(type_name(&b, child(&b, o, "customer")), "customer");
    let lines = child(&b, o, "lines");
    assert_eq!(type_name(&b, lines), "LineItem");
    assert!(b.components[lines as usize].json.as_ref().unwrap().array);
    assert_eq!(type_name(&b, child(&b, o, "tags")), "Tags");
    assert!(
        b.components[child(&b, o, "note") as usize]
            .json
            .as_ref()
            .unwrap()
            .deprecated
    );
    // Unresolved $ref: a diagnostic and a missing reference, no panic.
    assert_eq!(
        type_name(&b, child(&b, o, "extra")),
        "missing #/$defs/Missing"
    );
    assert_eq!(b.stats.unresolved_refs, 1);
    assert!(b.diagnostics.iter().any(|d| d.code == "unresolved-ref"));
    // allOf with a $ref: extension of the base.
    let card = b.find(Kind::ComplexType, "CardPayment").unwrap();
    let ct = b.components[card as usize].complex_type.as_ref().unwrap();
    let base = ct.derivation.as_ref().unwrap().base.id().unwrap();
    assert_eq!(b.qname(base), "Payment");
    assert_eq!(
        children(&b, ct.content.as_ref().unwrap()),
        ["cardNumber 1..1"]
    );
    assert!(
        b.components[base as usize]
            .complex_type
            .as_ref()
            .unwrap()
            .derived
            .contains(&card)
    );
    // oneOf: a choice.
    let pay = child(&b, o, "payment");
    let anon = b.components[pay as usize]
        .element
        .as_ref()
        .unwrap()
        .r#type
        .as_ref()
        .unwrap()
        .id()
        .unwrap();
    assert!(matches!(
        b.components[anon as usize]
            .complex_type
            .as_ref()
            .unwrap()
            .content,
        Some(Particle::Choice { .. })
    ));
    // Enumerations and facets.
    let st = b.find(Kind::SimpleType, "Status").unwrap();
    let si = b.components[st as usize].simple_type.as_ref().unwrap();
    let vals: Vec<&str> = si.enumerations.iter().map(|e| e.value.as_str()).collect();
    assert_eq!(vals, ["open", "paid", "cancelled"]);
    assert_eq!(b.qname(si.base.as_ref().unwrap().id().unwrap()), "string");
    // oneOf of consts: enumerations with documentation.
    let cust = b.find(Kind::ComplexType, "customer").unwrap();
    let kind = child(&b, cust, "kind");
    let kt = b.components[kind as usize]
        .element
        .as_ref()
        .unwrap()
        .r#type
        .as_ref()
        .unwrap()
        .id()
        .unwrap();
    let e = &b.components[kt as usize]
        .simple_type
        .as_ref()
        .unwrap()
        .enumerations;
    assert_eq!(e[1].value, "company");
    assert_eq!(e[1].docs[0].text, "A legal entity.");
    // patternProperties and additionalProperties.
    let tags = b.find(Kind::ComplexType, "Tags").unwrap();
    let ct = b.components[tags as usize].complex_type.as_ref().unwrap();
    assert_eq!(
        children(&b, ct.content.as_ref().unwrap()),
        ["^x- 0..*", "* 0..*"]
    );
    // Where used.
    let li = b.find(Kind::ComplexType, "LineItem").unwrap();
    assert!(
        b.components[li as usize]
            .used_by
            .iter()
            .any(|u| u.by == lines)
    );
    // Search.
    assert!(
        b.search
            .get("lineitem")
            .is_some_and(|ids| ids.contains(&li))
    );
}

#[test]
fn draft_04() {
    let b = load(&["legacy-draft04.json"]);
    assert_eq!(b.files[0].dialect.as_deref(), Some("JSON Schema draft-04"));
    let price = b.find(Kind::SimpleType, "Price").unwrap();
    let f = &b.components[price as usize]
        .simple_type
        .as_ref()
        .unwrap()
        .facets;
    assert!(
        f.iter()
            .any(|f| f.kind == "exclusiveMinimum" && f.value == "0")
    );
    assert!(!f.iter().any(|f| f.kind == "minimum"));
    let book = b.find(Kind::ComplexType, "Book").unwrap();
    let ct = b.components[book as usize].complex_type.as_ref().unwrap();
    assert_eq!(
        b.qname(ct.derivation.as_ref().unwrap().base.id().unwrap()),
        "Product"
    );
    let product = b.find(Kind::ComplexType, "Product").unwrap();
    assert_eq!(type_name(&b, child(&b, product, "price")), "Price");
    assert!(b.diagnostics.is_empty(), "{:?}", b.diagnostics);
}

#[test]
fn openapi_and_asyncapi() {
    let b = load(&["openapi.yaml"]);
    assert_eq!(b.files[0].dialect.as_deref(), Some("OpenAPI 3.0.3"));
    assert_eq!(b.files[0].version.as_deref(), Some("1.0.0"));
    let pet = b.find(Kind::ComplexType, "Pet").unwrap();
    let name = child(&b, pet, "name");
    let nt = b.components[name as usize]
        .element
        .as_ref()
        .unwrap()
        .r#type
        .as_ref()
        .unwrap()
        .id()
        .unwrap();
    assert!(
        b.components[nt as usize]
            .simple_type
            .as_ref()
            .unwrap()
            .facets
            .iter()
            .any(|f| f.kind == "nullable")
    );
    let dog = b.find(Kind::ComplexType, "Dog").unwrap();
    assert_eq!(
        b.qname(
            b.components[dog as usize]
                .complex_type
                .as_ref()
                .unwrap()
                .derivation
                .as_ref()
                .unwrap()
                .base
                .id()
                .unwrap()
        ),
        "Pet"
    );
    let pets = b.find(Kind::ComplexType, "Pets").unwrap();
    let ct = b.components[pets as usize].complex_type.as_ref().unwrap();
    assert_eq!(children(&b, ct.content.as_ref().unwrap()), ["items 0..100"]);

    let b = load(&["asyncapi.yaml"]);
    assert_eq!(b.files[0].dialect.as_deref(), Some("AsyncAPI 2.6.0"));
    let msg = b
        .find(Kind::ComplexType, "TrainPosition")
        .expect("message payload");
    assert_eq!(type_name(&b, child(&b, msg, "train")), "TrainId");
    let id = b.find(Kind::SimpleType, "TrainId").unwrap();
    assert_eq!(
        b.components[id as usize]
            .simple_type
            .as_ref()
            .unwrap()
            .variety,
        Variety::Atomic
    );
}

#[test]
fn files_named_alike_get_namespaces() {
    let b = load(&[
        "v1/order.schema.json",
        "v1/customer.yaml",
        "v2/order.schema.json",
    ]);
    assert_eq!(b.namespaces.len(), 3);
    assert!(b.find(Kind::ComplexType, "order:order").is_some());
}

fn has(c: &ComponentDiff, line: &str) {
    let all: Vec<String> = c
        .changes
        .iter()
        .map(|x| format!("{:?} {} {:?}", x.kind, x.subject, x.impact))
        .collect();
    assert!(all.iter().any(|l| l == line), "{line} not in {all:#?}");
}

fn comp<'a>(d: &'a SchemaDiff, kind: Kind, name: &str) -> &'a ComponentDiff {
    d.components
        .iter()
        .find(|c| c.kind == kind && c.name == name)
        .unwrap_or_else(|| panic!("{kind:?} {name} not in the diff"))
}

#[test]
fn diff_versions() {
    let d = diff(&order("v1"), &order("v2"), &DiffOptions::default());
    let o = comp(&d, Kind::ComplexType, "order");
    // A property that becomes required is breaking; a new optional one is not.
    has(o, "ChildCardinalityChanged status Breaking");
    has(o, "ChildAdded currency NonBreaking");
    let st = comp(&d, Kind::SimpleType, "Status");
    has(st, "EnumerationRemoved cancelled Breaking");
    has(st, "EnumerationAdded refunded NonBreaking");
    assert!(d.summary.total.breaking > 0);
    // Property order does not matter in JSON.
    assert!(
        !o.changes
            .iter()
            .any(|c| c.kind == ChangeKind::ChildrenReordered)
    );
}
