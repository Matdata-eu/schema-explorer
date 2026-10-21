//! Tests of the comparison of two versions, on the hand-written pair in
//! tests/data/diff (v1 → v2, whose target namespace changes too).

use schema_explorer_core::diff::*;
use schema_explorer_core::{Bundle, Kind, Options, Source, index, report};
use std::path::Path;

fn load(version: &str) -> Bundle {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/data/diff");
    let files = ["shop.xsd", "common.xsd"];
    index(
        files
            .iter()
            .map(|f| {
                Source::new(
                    format!("{version}/{f}"),
                    std::fs::read(dir.join(version).join(f)).unwrap(),
                )
            })
            .collect(),
        None,
        &Options::default(),
    )
}

fn run(opts: &DiffOptions) -> SchemaDiff {
    diff(&load("v1"), &load("v2"), opts)
}

fn comp<'a>(d: &'a SchemaDiff, kind: Kind, name: &str) -> &'a ComponentDiff {
    d.components
        .iter()
        .find(|c| c.kind == kind && c.name == name)
        .unwrap_or_else(|| panic!("{kind:?} {name} not in the diff"))
}

/// The changes of a component as `kind subject impact` lines.
fn changes(c: &ComponentDiff) -> Vec<String> {
    c.changes
        .iter()
        .map(|x| {
            let mut s = format!("{:?}", x.kind);
            if !x.path.is_empty() {
                s.push_str(&format!(" {}:", x.path));
            }
            if !x.subject.is_empty() {
                s.push_str(&format!(" {}", x.subject));
            }
            s.push_str(&format!(" {:?}", x.impact));
            s
        })
        .collect()
}

fn has(c: &ComponentDiff, line: &str) {
    let list = changes(c);
    assert!(list.iter().any(|l| l == line), "{line:?} not in {list:#?}");
}

#[test]
fn matches_across_namespaces() {
    let d = run(&DiffOptions::default());
    assert_eq!(d.format, DIFF_FORMAT);
    assert_eq!(
        d.namespace_map.get("urn:test:shop:1").map(String::as_str),
        Some("urn:test:shop:2")
    );
    let order = comp(&d, Kind::ComplexType, "Order");
    assert_eq!(order.status, Status::Changed);
    assert!(order.by_local_name);
    // Unchanged components are left out, even across the namespace change.
    assert!(!d.components.iter().any(|c| c.name == "book"));
    assert_eq!(d.old.version.as_deref(), Some("1.0"));
    assert_eq!(d.new.version.as_deref(), Some("2.0"));
}

#[test]
fn strict_namespaces() {
    let d = run(&DiffOptions {
        match_local_names: false,
        ..Default::default()
    });
    assert!(d.namespace_map.is_empty());
    // Everything in the target namespace is removed and added again.
    let order: Vec<Status> = d
        .components
        .iter()
        .filter(|c| c.name == "Order")
        .map(|c| c.status)
        .collect();
    assert_eq!(order.len(), 2, "{order:?}");
    assert!(order.contains(&Status::Removed) && order.contains(&Status::Added));
}

#[test]
fn added_removed_renamed() {
    let d = run(&DiffOptions::default());
    assert_eq!(comp(&d, Kind::Element, "legacy").status, Status::Removed);
    assert!(comp(&d, Kind::Element, "legacy").breaking());
    let dvd = comp(&d, Kind::Element, "dvd");
    assert_eq!(dvd.status, Status::Added);
    assert_eq!(dvd.impact, Impact::NonBreaking);
    assert_eq!(comp(&d, Kind::ComplexType, "Base").status, Status::Added);
    let addr = comp(&d, Kind::ComplexType, "Address");
    assert_eq!(addr.status, Status::Removed);
    assert_eq!(addr.possibly_renamed.as_deref(), Some("s:PostalAddress"));
    assert_eq!(d.renames.len(), 1);
    assert_eq!(d.renames[0].score, 100);
    let t = d.summary.total;
    assert_eq!((t.added, t.removed), (3, 2));
    assert_eq!(d.summary.by_kind[&Kind::Element].removed, 1);
    assert_eq!(d.summary.by_file["shop.xsd"].added, 3);
}

#[test]
fn content_model() {
    let d = run(&DiffOptions::default());
    let order = comp(&d, Kind::ComplexType, "Order");
    assert!(order.breaking());
    has(order, "ChildCardinalityChanged lines Breaking");
    has(order, "ChildAdded discount NonBreaking");
    has(order, "ChildAdded store NonBreaking");
    has(order, "ChildMoved channel Breaking");
    has(order, "ChildrenReordered note Breaking");
    has(order, "StructureChanged Breaking");
    // In the anonymous type of the local element `lines`.
    has(order, "AttributeRetyped lines: @count Breaking");
    let cust = comp(&d, Kind::ComplexType, "Customer");
    has(cust, "ChildCardinalityChanged email NonBreaking");
    has(cust, "ChildCardinalityChanged phone Breaking");
    let group = comp(&d, Kind::Group, "gContact");
    has(group, "ChildRemoved fax Breaking");
    has(group, "ChildAdded phone NonBreaking");
}

#[test]
fn attributes() {
    let d = run(&DiffOptions::default());
    let order = comp(&d, Kind::ComplexType, "Order");
    has(order, "AttributeRemoved @legacyCode Breaking");
    has(order, "AttributeAdded @currency Breaking");
    has(order, "AttributeDefaultChanged @status NonBreaking");
    has(
        comp(&d, Kind::ComplexType, "Customer"),
        "AttributeAdded @vip NonBreaking",
    );
    has(
        comp(&d, Kind::AttributeGroup, "aAudit"),
        "AttributeAdded @by Breaking",
    );
}

#[test]
fn types_and_facets() {
    let d = run(&DiffOptions::default());
    let item = comp(&d, Kind::ComplexType, "Item");
    has(item, "BaseChanged Breaking");
    has(item, "AbstractChanged Breaking");
    let st = comp(&d, Kind::SimpleType, "tStatus");
    has(st, "EnumerationAdded new NonBreaking");
    has(st, "EnumerationRemoved cancelled Breaking");
    let code = comp(&d, Kind::SimpleType, "tCode");
    has(code, "FacetChanged maxLength Breaking");
    has(code, "FacetAdded minLength Breaking");
    let amount = comp(&d, Kind::SimpleType, "tAmount");
    has(amount, "FacetChanged fractionDigits NonBreaking");
    assert_eq!(amount.impact, Impact::NonBreaking);
}

#[test]
fn substitution_groups() {
    let d = run(&DiffOptions::default());
    let head = comp(&d, Kind::Element, "item");
    has(head, "SubstitutionMemberRemoved s:cd Breaking");
    has(head, "SubstitutionMemberAdded s:dvd NonBreaking");
    has(
        comp(&d, Kind::Element, "cd"),
        "SubstitutionGroupChanged Breaking",
    );
}

#[test]
fn documentation() {
    let d = run(&DiffOptions::default());
    let order = comp(&d, Kind::ComplexType, "Order");
    let doc = order
        .changes
        .iter()
        .find(|c| c.kind == ChangeKind::DocsChanged)
        .unwrap();
    assert_eq!(doc.impact, Impact::Info);
    assert_eq!(doc.old.as_deref(), Some("An order."));
    assert_eq!(doc.new.as_deref(), Some("An order placed by a customer."));
    let d = run(&DiffOptions {
        docs: false,
        ..Default::default()
    });
    assert!(
        d.components
            .iter()
            .all(|c| c.changes.iter().all(|x| x.kind != ChangeKind::DocsChanged))
    );
}

#[test]
fn identical_sets() {
    let d = diff(&load("v1"), &load("v1"), &DiffOptions::default());
    assert!(d.components.is_empty(), "{:#?}", d.components);
    assert_eq!(d.summary.total.total(), 0);
}

#[test]
fn json_and_reports() {
    let d = run(&DiffOptions::default());
    let json = serde_json::to_string(&d).unwrap();
    let back: SchemaDiff = serde_json::from_str(&json).unwrap();
    assert_eq!(back, d);
    let md = report::markdown(&d);
    assert!(md.starts_with("# Schema changes: version 1.0 → version 2.0"));
    assert!(md.contains("- − enumeration value removed: `cancelled` **breaking**"));
    assert!(md.contains("| complexType | `s:Address` | `s:PostalAddress` | 100% |"));
    let html = report::html(&d);
    assert!(html.contains("<code>s:PostalAddress</code>"));
    assert!(!html.contains("<script"));
}
