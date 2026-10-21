//! Tests on real-world schemas.
//!
//! Real schemas are not committed. Tests read them from the directory in the
//! `SCHEMA_FIXTURES` environment variable (default: `tests/fixtures` at the
//! repository root) and are skipped when a schema set is absent. Fetch the
//! public ones with `scripts/fetch-fixtures.sh`; the railML and telematics
//! sets are expected under `railml/<version>/{schema,codelists}` and
//! `telematics/{netex,taf,taf-v3.5.1,b5,b10}`.
//!
//! Run with `--nocapture` (in release mode for meaningful timings) to see
//! the counts and indexing times.

use schema_explorer_core::bundle::{Bundle, Kind};
use schema_explorer_core::{Options, Source, index};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

fn fixtures_dir() -> PathBuf {
    match std::env::var_os("SCHEMA_FIXTURES") {
        Some(dir) => PathBuf::from(dir),
        None => Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures"),
    }
}

fn collect(path: &Path, out: &mut Vec<PathBuf>) {
    if path.is_dir() {
        let mut entries: Vec<PathBuf> = std::fs::read_dir(path)
            .into_iter()
            .flatten()
            .flatten()
            .map(|e| e.path())
            .collect();
        entries.sort();
        for p in entries {
            if p.is_dir() || p.extension().is_some_and(|x| x == "xsd") {
                collect(&p, out);
            }
        }
    } else if path.is_file() {
        out.push(path.to_path_buf());
    }
}

struct Run {
    bundle: Bundle,
    /// Indexing time from memory (files already read).
    time: Duration,
}

/// Index the given fixture paths (files or directories, relative to the
/// fixtures directory), following imports from disk. `None` when absent.
fn run(label: &str, paths: &[&str]) -> Option<Run> {
    let root = fixtures_dir();
    let mut files = Vec::new();
    for p in paths {
        let full = root.join(p);
        if !full.exists() {
            eprintln!("skipping {label}: {} not found", full.display());
            return None;
        }
        collect(&full, &mut files);
    }
    let sources: Vec<Source> = files
        .iter()
        .map(|f| Source::new(f.to_string_lossy(), std::fs::read(f).unwrap()))
        .collect();
    // First run: from disk, remembering what the resolver read.
    let mut read: HashMap<String, Vec<u8>> = HashMap::new();
    let mut resolver = |path: &str| {
        let bytes = std::fs::read(path).ok()?;
        read.insert(path.to_string(), bytes.clone());
        Some(bytes)
    };
    let first = index(sources.clone(), Some(&mut resolver), &Options::default());
    // Second run: everything in memory, timed.
    let mut all = sources;
    all.extend(read.into_iter().map(|(n, b)| Source::new(n, b)));
    let start = Instant::now();
    let bundle = index(all, None, &Options::default());
    let time = start.elapsed();
    assert_eq!(first.components.len(), bundle.components.len());
    let s = &bundle.stats;
    let g = |k| s.global.get(&k).copied().unwrap_or(0);
    eprintln!(
        "{label}: {} files, {} complex types, {} simple types, {} elements, {} groups, {} attribute groups (global); {} local; {} enumerations; {} unresolved imports, {} unresolved refs; indexed in {time:.2?}",
        s.files,
        g(Kind::ComplexType),
        g(Kind::SimpleType),
        g(Kind::Element),
        g(Kind::Group),
        g(Kind::AttributeGroup),
        s.local.values().sum::<u32>(),
        s.enumerations,
        s.unresolved_imports,
        s.unresolved_refs,
    );
    for d in bundle.unresolved_imports() {
        eprintln!(
            "  {}: {}",
            bundle.files[d.file.unwrap() as usize].name,
            d.message
        );
    }
    Some(Run { bundle, time })
}

/// Assert the counts are at least the given minima.
fn at_least(b: &Bundle, complex: u32, simple: u32, elements: u32) {
    let g = |k| b.stats.global.get(&k).copied().unwrap_or(0);
    assert!(
        g(Kind::ComplexType) >= complex,
        "complex types: {}",
        g(Kind::ComplexType)
    );
    assert!(
        g(Kind::SimpleType) >= simple,
        "simple types: {}",
        g(Kind::SimpleType)
    );
    assert!(
        g(Kind::Element) >= elements,
        "elements: {}",
        g(Kind::Element)
    );
}

fn no_unresolved_imports(b: &Bundle) {
    let list: Vec<&str> = b.unresolved_imports().map(|d| d.message.as_str()).collect();
    assert!(list.is_empty(), "unresolved imports: {list:?}");
}

fn netex(label: &str, entry: &str) {
    let Some(r) = run(label, &[entry]) else {
        return;
    };
    let b = &r.bundle;
    no_unresolved_imports(b);
    assert_eq!(b.stats.unresolved_refs, 0);
    at_least(b, 2500, 1500, 1800);
    let pd = b
        .find(Kind::Element, "netex:PublicationDelivery")
        .expect("PublicationDelivery");
    assert!(
        !b.components[pd as usize]
            .element
            .as_ref()
            .unwrap()
            .identity
            .is_empty()
    );
    // Deep inheritance: the effective content of a stop place spans many types.
    let sp = b
        .find(Kind::ComplexType, "netex:StopPlace_VersionStructure")
        .unwrap();
    let eff = b.components[sp as usize]
        .complex_type
        .as_ref()
        .unwrap()
        .effective
        .as_ref()
        .unwrap();
    assert!(eff.content.len() >= 5, "{:?}", eff.content);
    assert!(
        eff.attributes
            .iter()
            .any(|a| b.qname(a.attr.id().unwrap()) == "id")
    );
    if !cfg!(debug_assertions) {
        assert!(r.time < Duration::from_secs(5), "NeTEx took {:?}", r.time);
    }
}

#[test]
fn netex_upstream() {
    netex("NeTEx (upstream clone)", "NeTEx/xsd/NeTEx_publication.xsd");
}

#[test]
fn netex_telematics() {
    netex(
        "NeTEx (telematics)",
        "telematics/netex/NeTEx_publication.xsd",
    );
}

#[test]
fn railml_3_1() {
    let Some(r) = run("railML 3.1", &["railml/3.1/schema"]) else {
        return;
    };
    let b = &r.bundle;
    // Known upstream breakage: common3.xsd imports Dublin Core from
    // dublincore.org and railML 3.1 does not ship a local copy.
    let list: Vec<&str> = b.unresolved_imports().map(|d| d.message.as_str()).collect();
    assert_eq!(list.len(), 1, "{list:?}");
    assert!(list[0].contains("dublincore.org"));
    at_least(b, 350, 50, 1);
}

fn railml(version: &str) {
    let label = format!("railML {version}");
    let schema = format!("railml/{version}/schema");
    let codelists = format!("railml/{version}/codelists");
    let Some(r) = run(&label, &[&schema, &codelists]) else {
        return;
    };
    let b = &r.bundle;
    no_unresolved_imports(b);
    assert_eq!(b.stats.unresolved_refs, 0);
    at_least(b, 600, 150, 1);
    let railml = b
        .find(Kind::Element, "rail3:railML")
        .expect("railML root element");
    assert!(b.components[railml as usize].file.is_some());
}

#[test]
fn railml_3_2() {
    railml("3.2");
}

#[test]
fn railml_3_3() {
    railml("3.3");
}

#[test]
fn taf() {
    for dir in ["telematics/taf", "telematics/taf-v3.5.1"] {
        // taf_cat_complete_fixed.xsd is a corrected copy of
        // taf_cat_complete.xsd: index each on its own.
        for entry in ["taf_cat_complete.xsd", "taf_cat_complete_fixed.xsd"] {
            let path = format!("{dir}/{entry}");
            let Some(r) = run(&path, &[&path]) else {
                continue;
            };
            no_unresolved_imports(&r.bundle);
            at_least(&r.bundle, 10, 150, 350);
        }
    }
}

#[test]
fn taf_extension() {
    // Known upstream gap: EI_TAF_Extension.xsd imports TAF 4.0
    // (taf_cat_complete.xsd as a sibling) while the fixtures hold TAF 3.5,
    // whose namespace differs. One unresolved import; the rest reads.
    let Some(r) = run("EI_TAF_Extension", &["telematics/EI_TAF_Extension.xsd"]) else {
        return;
    };
    let list: Vec<&str> = r
        .bundle
        .unresolved_imports()
        .map(|d| d.message.as_str())
        .collect();
    assert_eq!(list, ["cannot find the import taf_cat_complete.xsd"]);
    at_least(&r.bundle, 20, 1, 30);
}

#[test]
fn tap_b5_b10() {
    if let Some(r) = run("TAP B.5", &["telematics/b5"]) {
        no_unresolved_imports(&r.bundle);
        at_least(&r.bundle, 50, 10, 20);
    }
    if let Some(r) = run("TAP B.10", &["telematics/b10"]) {
        no_unresolved_imports(&r.bundle);
        at_least(&r.bundle, 10, 10, 1);
    }
}
