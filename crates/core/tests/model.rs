//! Tests on the small hand-written schemas in tests/data.

use schema_explorer_core::bundle::*;
use schema_explorer_core::{Options, Source, index, to_json};
use std::path::Path;

fn data(files: &[&str]) -> Vec<Source> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/data");
    files
        .iter()
        .map(|f| Source::new(*f, std::fs::read(dir.join(f)).unwrap()))
        .collect()
}

fn basic() -> Bundle {
    index(
        data(&["basic/main.xsd", "basic/sub/common.xsd", "basic/other.xsd"]),
        None,
        &Options::default(),
    )
}

fn get<'a>(b: &'a Bundle, kind: Kind, q: &str) -> (Id, &'a Component) {
    let id = b
        .find(kind, q)
        .unwrap_or_else(|| panic!("{kind:?} {q} not found"));
    (id, &b.components[id as usize])
}

fn name(b: &Bundle, r: &Ref) -> String {
    match r {
        Ref::Id(id) => b.qname(*id),
        Ref::Missing(s) => format!("?{s}"),
    }
}

#[test]
fn files_and_namespaces() {
    let b = basic();
    assert_eq!(b.format, FORMAT);
    let names: Vec<&str> = b.files.iter().map(|f| f.name.as_str()).collect();
    assert_eq!(names, ["main.xsd", "sub/common.xsd", "other.xsd"]);
    let main = &b.files[0];
    assert_eq!(main.version.as_deref(), Some("1.2"));
    assert!(main.element_form_qualified);
    assert_eq!(main.docs[0].text, "Main test schema.");
    assert_eq!(main.directives[0].file, Some(1));
    assert_eq!(main.directives[1].file, Some(2));
    assert_eq!(main.directives[2].via.as_deref(), Some("builtin"));
    assert_eq!(b.stats.unresolved_imports, 0);
    // The chameleon include takes the main namespace.
    assert_eq!(b.files[1].namespace, b.files[0].namespace);
    let prefixes: Vec<(&str, &str)> = b
        .namespaces
        .iter()
        .map(|n| (n.prefix.as_str(), n.uri.as_str()))
        .collect();
    assert!(prefixes.contains(&("m", "urn:test:main")));
    assert!(prefixes.contains(&("o", "urn:test:other")));
    assert!(prefixes.contains(&("xs", "http://www.w3.org/2001/XMLSchema")));
    assert_eq!(
        b.files[2].prefixes.get(""),
        Some(&"urn:test:other".to_string())
    );
}

#[test]
fn only_the_missing_type_is_unresolved() {
    let b = basic();
    let refs: Vec<&str> = b
        .diagnostics
        .iter()
        .filter(|d| d.code == "unresolved-ref")
        .map(|d| d.message.as_str())
        .collect();
    assert_eq!(refs.len(), 1, "{refs:?}");
    assert!(refs[0].contains("m:Missing"));
    assert_eq!(b.stats.unresolved_refs, 1);
    let (_, unknown) = get(&b, Kind::Element, "m:Unknown");
    assert_eq!(
        unknown.element.as_ref().unwrap().r#type,
        Some(Ref::Missing("{urn:test:main}Missing".into()))
    );
}

#[test]
fn complex_types_and_inheritance() {
    let b = basic();
    let (base_id, base) = get(&b, Kind::ComplexType, "m:Base");
    assert_eq!(base.line, 10);
    assert_eq!(base.file, Some(0));
    assert_eq!(base.docs.len(), 2);
    assert_eq!(base.docs[1].lang.as_deref(), Some("fr"));
    assert_eq!(base.appinfo, ["<m:status>stable</m:status>"]);
    let ct = base.complex_type.as_ref().unwrap();
    assert!(ct.r#abstract);
    let Some(Particle::Sequence { items, .. }) = &ct.content else {
        panic!("{:?}", ct.content)
    };
    let Particle::Element { el, occurs } = &items[1] else {
        panic!()
    };
    assert_eq!(occurs.min, 0);
    assert_eq!(occurs.max, None);
    let note = &b.components[el.id().unwrap() as usize];
    assert_eq!(note.name, "note");
    assert_eq!(note.parent, Some(base_id));
    assert_eq!(
        b.qname(el.id().unwrap()),
        "m:note",
        "qualified local element"
    );
    assert!(note.element.as_ref().unwrap().nillable);

    let (derived_id, derived) = get(&b, Kind::ComplexType, "m:Derived");
    let (restricted_id, _) = get(&b, Kind::ComplexType, "m:Restricted");
    let (circle_id, circle) = get(&b, Kind::Element, "m:Circle");
    let circle_type = circle
        .element
        .as_ref()
        .unwrap()
        .r#type
        .as_ref()
        .unwrap()
        .id()
        .unwrap();
    assert_eq!(b.components[circle_type as usize].parent, Some(circle_id));
    // Both directions of the base chain.
    assert_eq!(ct.derived, [derived_id]);
    let dct = derived.complex_type.as_ref().unwrap();
    assert_eq!(dct.derived, [restricted_id, circle_type]);
    let d = dct.derivation.as_ref().unwrap();
    assert_eq!(
        (d.method, d.base.clone()),
        (Method::Extension, Ref::Id(base_id))
    );
    assert!(
        matches!(&dct.content, Some(Particle::Choice { items, .. }) if matches!(items[2], Particle::Any { .. }))
    );
    assert_eq!(
        dct.any_attribute.as_ref().unwrap().namespace.as_deref(),
        Some("##other")
    );

    // Effective content: inherited particles and attributes.
    let eff = dct.effective.as_ref().unwrap();
    assert_eq!(eff.content, [base_id, derived_id]);
    let attrs: Vec<String> = eff.attributes.iter().map(|a| name(&b, &a.attr)).collect();
    assert_eq!(attrs, ["version", "obsolete", "created", "unit", "o:flag"]);
    assert_eq!(eff.attributes[0].default.as_deref(), Some("1"));
    assert_eq!(
        eff.attributes[2].via,
        b.find(Kind::AttributeGroup, "m:Common")
    );
    assert_eq!(eff.attributes[4].r#use, AttrUse::Required);
    assert_eq!(eff.attributes[4].from, derived_id);

    let circle_eff = b.components[circle_type as usize]
        .complex_type
        .as_ref()
        .unwrap()
        .effective
        .as_ref()
        .unwrap();
    assert_eq!(circle_eff.content, [base_id, derived_id, circle_type]);

    let restricted = b.components[restricted_id as usize]
        .complex_type
        .as_ref()
        .unwrap();
    let eff = restricted.effective.as_ref().unwrap();
    assert_eq!(eff.content, [restricted_id]);
    let attrs: Vec<String> = eff.attributes.iter().map(|a| name(&b, &a.attr)).collect();
    assert_eq!(
        attrs,
        ["version", "created", "unit", "o:flag"],
        "obsolete is prohibited"
    );

    let (_, measure) = get(&b, Kind::ComplexType, "m:Measure");
    let eff = measure
        .complex_type
        .as_ref()
        .unwrap()
        .effective
        .as_ref()
        .unwrap();
    assert_eq!(
        eff.simple.as_ref().map(|r| name(&b, r)).as_deref(),
        Some("xs:decimal")
    );
    assert!(eff.content.is_empty());

    let (_, tag) = get(&b, Kind::ComplexType, "o:Tag");
    let tag = tag.complex_type.as_ref().unwrap();
    assert!(tag.mixed);
    let Some(Particle::All { items, .. }) = &tag.content else {
        panic!()
    };
    let Particle::Element { el, .. } = &items[0] else {
        panic!()
    };
    assert_eq!(
        b.qname(el.id().unwrap()),
        "label",
        "unqualified local element"
    );

    let (_, range) = get(&b, Kind::ComplexType, "m:Range");
    assert_eq!(range.complex_type.as_ref().unwrap().asserts, ["min le max"]);
}

#[test]
fn simple_types() {
    let b = basic();
    let (colour_id, colour) = get(&b, Kind::SimpleType, "m:Colour");
    let st = colour.simple_type.as_ref().unwrap();
    assert_eq!(st.variety, Variety::Atomic);
    assert_eq!(name(&b, st.base.as_ref().unwrap()), "xs:token");
    let values: Vec<&str> = st.enumerations.iter().map(|e| e.value.as_str()).collect();
    assert_eq!(values, ["red", "green", "blue"]);
    assert_eq!(st.enumerations[0].docs[1].lang.as_deref(), Some("nl"));
    assert_eq!(st.enumerations[0].docs[0].text, "Red as a rose.");

    let (_, list) = get(&b, Kind::SimpleType, "m:Colours");
    let list = list.simple_type.as_ref().unwrap();
    assert_eq!(list.variety, Variety::List);
    assert_eq!(list.item, Some(Ref::Id(colour_id)));

    let (union_id, union) = get(&b, Kind::SimpleType, "m:ColourOrCode");
    let union = union.simple_type.as_ref().unwrap();
    assert_eq!(union.variety, Variety::Union);
    assert_eq!(union.members[0], Ref::Id(colour_id));
    let anon = &b.components[union.members[1].id().unwrap() as usize];
    assert!(anon.name.is_empty());
    assert_eq!(anon.parent, Some(union_id));
    let facets = &anon.simple_type.as_ref().unwrap().facets;
    assert_eq!(facets[0].kind, "pattern");
    assert_eq!(facets[1].kind, "maxLength");
    assert!(facets[1].fixed);

    // Built-in types are components with their own base chain.
    let token = st.base.as_ref().unwrap().id().unwrap();
    assert!(b.components[token as usize].builtin);
    let token_base = b.components[token as usize]
        .simple_type
        .as_ref()
        .unwrap()
        .base
        .clone();
    assert_eq!(name(&b, &token_base.unwrap()), "xs:normalizedString");

    // The chameleon type is in the including namespace.
    let (_, unit) = get(&b, Kind::SimpleType, "m:Unit");
    assert_eq!(unit.file, Some(1));
}

#[test]
fn elements_substitution_and_identity() {
    let b = basic();
    let (shape_id, shape) = get(&b, Kind::Element, "m:Shape");
    let (circle_id, _) = get(&b, Kind::Element, "m:Circle");
    let (square_id, square) = get(&b, Kind::Element, "m:Square");
    let e = shape.element.as_ref().unwrap();
    assert!(e.r#abstract);
    assert_eq!(e.members, [circle_id, square_id]);
    let sq = square.element.as_ref().unwrap();
    assert_eq!(sq.substitution_group, [Ref::Id(shape_id)]);
    assert_eq!(sq.r#final.as_deref(), Some("#all"));
    let (_, colour) = get(&b, Kind::Element, "m:colour");
    assert_eq!(
        colour.element.as_ref().unwrap().default.as_deref(),
        Some("red")
    );
    let (_, answer) = get(&b, Kind::Element, "m:answer");
    assert_eq!(
        answer.element.as_ref().unwrap().fixed.as_deref(),
        Some("42")
    );

    let (root_id, root) = get(&b, Kind::Element, "m:Root");
    let ids = &root.element.as_ref().unwrap().identity;
    assert_eq!(ids.len(), 3);
    let key = &b.components[ids[0] as usize];
    assert_eq!(
        (key.kind, key.name.as_str(), key.parent),
        (Kind::Key, "ShapeKey", Some(root_id))
    );
    assert_eq!(key.identity.as_ref().unwrap().fields, ["m:id"]);
    let keyref = &b.components[ids[1] as usize];
    assert_eq!(keyref.kind, Kind::Keyref);
    assert_eq!(
        keyref.identity.as_ref().unwrap().refer,
        Some(Ref::Id(ids[0]))
    );
    assert_eq!(b.components[ids[2] as usize].kind, Kind::Unique);
    assert_eq!(
        key.used_by,
        [Usage {
            by: ids[1],
            how: UseKind::Refer
        }]
    );

    // xml:lang without the XML namespace schema.
    let lang = b.find(Kind::Attribute, "xml:lang").unwrap();
    assert!(b.components[lang as usize].builtin);
}

#[test]
fn where_used() {
    let b = basic();
    let users = |kind, q| -> Vec<(String, UseKind)> {
        let (_, c) = get(&b, kind, q);
        c.used_by
            .iter()
            .map(|u| {
                let mut top = u.by;
                while let Some(p) = b.components[top as usize].parent {
                    top = p;
                }
                (b.qname(top), u.how)
            })
            .collect()
    };
    assert_eq!(
        users(Kind::ComplexType, "m:Base"),
        [
            ("m:Derived".into(), UseKind::Base),
            ("m:Shape".into(), UseKind::Type)
        ]
    );
    assert_eq!(
        users(Kind::Element, "m:Shape"),
        [
            ("m:Derived".into(), UseKind::Element),
            ("m:Restricted".into(), UseKind::Element),
            ("m:Circle".into(), UseKind::Substitution),
            ("m:Square".into(), UseKind::Substitution),
            ("m:Root".into(), UseKind::Element),
        ]
    );
    assert_eq!(
        users(Kind::Group, "m:Extra"),
        [("m:Derived".into(), UseKind::Group)]
    );
    assert_eq!(
        users(Kind::AttributeGroup, "m:Common"),
        [("m:Base".into(), UseKind::AttributeGroup)]
    );
    assert_eq!(
        users(Kind::Attribute, "o:flag"),
        [("m:Derived".into(), UseKind::Attribute)]
    );
    assert_eq!(
        users(Kind::SimpleType, "m:Colour"),
        [
            ("m:Colours".into(), UseKind::Item),
            ("m:ColourOrCode".into(), UseKind::Member),
            ("m:colour".into(), UseKind::Type),
        ]
    );
    assert_eq!(users(Kind::SimpleType, "m:Unit").len(), 2);
}

#[test]
fn search_index() {
    let b = basic();
    let shape = b.find(Kind::Element, "m:Shape").unwrap();
    assert!(b.search["shape"].contains(&shape));
    let colour = b.find(Kind::SimpleType, "m:Colour").unwrap();
    assert!(
        b.search["rose"].contains(&colour),
        "enumeration documentation"
    );
    assert!(b.search["green"].contains(&colour), "enumeration value");
    let base = b.find(Kind::ComplexType, "m:Base").unwrap();
    assert!(b.search["everything"].contains(&base));
    let derived = b.find(Kind::ComplexType, "m:Derived").unwrap();
    assert!(b.search["derived"].contains(&derived));
}

#[test]
fn json_round_trip_and_compact() {
    let b = basic();
    let json = to_json(&b).unwrap();
    let back: Bundle = serde_json::from_str(&json).unwrap();
    assert_eq!(to_json(&back).unwrap(), json);
    let compact = index(
        data(&["basic/main.xsd", "basic/sub/common.xsd", "basic/other.xsd"]),
        None,
        &Options {
            compact: true,
            ..Default::default()
        },
    );
    assert!(compact.compact);
    assert!(compact.search.is_empty());
    let cjson = to_json(&compact).unwrap();
    assert!(cjson.len() < json.len());
    let v: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(v["format"], FORMAT);
    // Expanding the compact form gives the full bundle back.
    let mut expanded: Bundle = serde_json::from_str(&cjson).unwrap();
    schema_explorer_core::expand(&mut expanded);
    assert_eq!(to_json(&expanded).unwrap(), json);
}

#[test]
fn imports_are_followed_through_the_resolver() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/data");
    let mut asked = Vec::new();
    let mut resolver = |path: &str| {
        asked.push(path.to_string());
        std::fs::read(dir.join(path)).ok()
    };
    let b = index(
        data(&["basic/main.xsd"]),
        Some(&mut resolver),
        &Options::default(),
    );
    assert_eq!(
        asked,
        [
            "basic/sub/common.xsd",
            "basic/other.xsd",
            "http://www.w3.org/2001/xml.xsd"
        ]
    );
    assert_eq!(b.files.len(), 3);
    assert!(b.files[0].input && !b.files[1].input);
    assert_eq!(b.stats.unresolved_imports, 0);
    assert!(b.find(Kind::ComplexType, "o:Tag").is_some());
}

#[test]
fn flat_upload_resolves_by_file_name() {
    // As when files are dropped in the browser without their folders.
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/data/basic");
    let sources = ["main.xsd", "sub/common.xsd", "other.xsd"]
        .iter()
        .map(|f| {
            Source::new(
                f.rsplit('/').next().unwrap(),
                std::fs::read(dir.join(f)).unwrap(),
            )
        })
        .collect();
    let b = index(sources, None, &Options::default());
    assert_eq!(b.stats.unresolved_imports, 0);
    assert_eq!(b.files[0].directives[0].via.as_deref(), Some("filename"));
    assert_eq!(b.files[0].directives[1].file, Some(2));
}

#[test]
fn broken_input_gives_diagnostics() {
    let b = index(
        data(&["broken/broken.xsd", "broken/notxml.xsd"]),
        None,
        &Options::default(),
    );
    let codes: Vec<&str> = b.diagnostics.iter().map(|d| d.code.as_str()).collect();
    assert_eq!(
        codes.iter().filter(|c| **c == "unresolved-import").count(),
        2,
        "{:?}",
        b.diagnostics
    );
    assert!(codes.contains(&"parse-error"));
    assert!(codes.contains(&"duplicate"));
    assert!(codes.contains(&"cycle"));
    let dup = b
        .diagnostics
        .iter()
        .find(|d| d.code == "duplicate")
        .unwrap();
    assert_eq!((dup.file, dup.line), (Some(0), 11));
    assert_eq!(b.stats.global[&Kind::Element], 1);
}

#[test]
fn redefine() {
    let b = index(
        data(&["redefine/main.xsd", "redefine/base.xsd"]),
        None,
        &Options::default(),
    );
    assert_eq!(b.stats.unresolved_imports, 0);
    let (_, person) = get(&b, Kind::Element, "r:person");
    let ty = person
        .element
        .as_ref()
        .unwrap()
        .r#type
        .as_ref()
        .unwrap()
        .id()
        .unwrap();
    let redefined = &b.components[ty as usize];
    let original = redefined.redefines.expect("redefines the original");
    assert_eq!(b.components[original as usize].file, Some(1));
    let ct = redefined.complex_type.as_ref().unwrap();
    assert_eq!(ct.derivation.as_ref().unwrap().base, Ref::Id(original));
    assert_eq!(ct.effective.as_ref().unwrap().content, [original, ty]);
}
