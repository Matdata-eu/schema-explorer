//! Readable reports of a [`SchemaDiff`]: Markdown for release notes and a
//! standalone HTML page.

use std::collections::BTreeMap;
use std::fmt::Write;

use crate::bundle::Kind;
use crate::diff::{
    ChangeKind, ComponentDiff, Counts, Impact, SchemaDiff, Status, change_label, kind_name,
};

/// Inline text: `code` and **bold** spans are rendered by each backend.
enum Block {
    H(u8, String),
    P(String),
    List(Vec<String>),
    Table(Vec<String>, Vec<Vec<String>>),
}

/// `+` for additions, `−` for removals, `~` for other changes.
pub fn marker(k: ChangeKind) -> &'static str {
    use ChangeKind::*;
    match k {
        SubstitutionMemberAdded
        | ChildAdded
        | AttributeAdded
        | EnumerationAdded
        | FacetAdded
        | MemberTypeAdded
        | AssertAdded => "+",
        SubstitutionMemberRemoved
        | ChildRemoved
        | AttributeRemoved
        | EnumerationRemoved
        | FacetRemoved
        | MemberTypeRemoved
        | AssertRemoved => "−",
        _ => "~",
    }
}

fn plural(k: Kind) -> &'static str {
    match k {
        Kind::ComplexType => "Complex types",
        Kind::SimpleType => "Simple types",
        Kind::Element => "Elements",
        Kind::Attribute => "Attributes",
        Kind::Group => "Groups",
        Kind::AttributeGroup => "Attribute groups",
        _ => "Other",
    }
}

/// Backticks inside code spans are replaced: they cannot be escaped portably.
fn code(s: &str) -> String {
    format!("`{}`", s.replace('`', "'"))
}

fn short(s: &str, max: usize) -> String {
    let one = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if one.chars().count() > max {
        format!("{}…", one.chars().take(max).collect::<String>())
    } else {
        one
    }
}

fn change_line(c: &crate::diff::Change) -> String {
    let mut s = format!("{} {}", marker(c.kind), change_label(c.kind));
    if !c.path.is_empty() {
        let _ = write!(s, " in {}", code(&c.path));
    }
    if !c.subject.is_empty() {
        let _ = write!(s, ": {}", code(&short(&c.subject, 120)));
    }
    if c.kind != ChangeKind::DocsChanged && (c.old.is_some() || c.new.is_some()) {
        let v = |x: &Option<String>| {
            x.as_deref()
                .map_or("(none)".to_string(), |v| code(&short(v, 120)))
        };
        match c.kind {
            ChangeKind::ChildAdded | ChangeKind::AttributeAdded | ChangeKind::FacetAdded => {
                let _ = write!(s, " ({})", c.new.as_deref().unwrap_or(""));
            }
            ChangeKind::ChildRemoved | ChangeKind::AttributeRemoved | ChangeKind::FacetRemoved => {
                let _ = write!(s, " (was {})", c.old.as_deref().unwrap_or(""));
            }
            _ => {
                let _ = write!(s, " ({} → {})", v(&c.old), v(&c.new));
            }
        }
    }
    if c.impact == Impact::Breaking {
        s.push_str(" **breaking**");
    }
    s
}

fn heading(d: &ComponentDiff) -> String {
    let mut s = format!("{} {}", kind_name(d.kind), code(d.qname()));
    if let Some(o) = &d.old
        && d.new.is_some()
        && o.qname != d.qname()
    {
        let _ = write!(s, " (was {})", code(&o.qname));
    }
    if let Some(f) = d.file() {
        s.push_str(&format!(" · {f}"));
    }
    s
}

fn counts_row(label: String, c: &Counts) -> Vec<String> {
    vec![
        label,
        c.added.to_string(),
        c.removed.to_string(),
        c.changed.to_string(),
        c.breaking.to_string(),
    ]
}

fn set_label(s: &crate::diff::SetInfo) -> String {
    if let Some(t) = &s.title {
        return t.clone();
    }
    if let Some(v) = &s.version {
        return format!("version {v}");
    }
    format!("{} files", s.files)
}

fn blocks(d: &SchemaDiff) -> Vec<Block> {
    let mut out = Vec::new();
    let title = format!(
        "Schema changes: {} → {}",
        set_label(&d.old),
        set_label(&d.new)
    );
    out.push(Block::H(1, title));
    let t = &d.summary.total;
    out.push(Block::P(format!(
        "{} added, {} removed and {} changed global components; {} breaking changes in {} components. {} components changed only in their documentation. Compared {} files with {} files.",
        t.added, t.removed, t.changed, d.summary.breaking_changes, t.breaking, t.docs_only, d.old.files, d.new.files
    )));
    if !d.namespace_map.is_empty() {
        out.push(Block::P(
            "The target namespace changed; components were matched by kind and local name:".into(),
        ));
        out.push(Block::List(
            d.namespace_map
                .iter()
                .map(|(a, b)| format!("{} → {}", code(a), code(b)))
                .collect(),
        ));
    }
    let head = || {
        vec![
            "".to_string(),
            "Added".into(),
            "Removed".into(),
            "Changed".into(),
            "Breaking".into(),
        ]
    };
    out.push(Block::H(2, "Summary".into()));
    let mut rows: Vec<Vec<String>> = d
        .summary
        .by_kind
        .iter()
        .map(|(k, c)| counts_row(plural(*k).into(), c))
        .collect();
    rows.push(counts_row("**Total**".into(), t));
    out.push(Block::Table(head(), rows));
    if d.summary.by_namespace.len() > 1 {
        out.push(Block::H(3, "By namespace".into()));
        let rows = d
            .summary
            .by_namespace
            .iter()
            .map(|(k, c)| {
                counts_row(
                    if k.is_empty() {
                        "(none)".into()
                    } else {
                        code(k)
                    },
                    c,
                )
            })
            .collect();
        out.push(Block::Table(head(), rows));
    }
    if d.summary.by_file.len() > 1 {
        out.push(Block::H(3, "By file".into()));
        let rows = d
            .summary
            .by_file
            .iter()
            .map(|(k, c)| counts_row(code(k), c))
            .collect();
        out.push(Block::Table(head(), rows));
    }

    let by_kind = |status: Status| {
        let mut m: BTreeMap<Kind, Vec<String>> = BTreeMap::new();
        for c in d.components.iter().filter(|c| c.status == status) {
            let mut s = code(c.qname());
            if let Some(r) = &c.possibly_renamed {
                let _ = write!(
                    s,
                    " (possibly renamed {} {})",
                    if status == Status::Added {
                        "from"
                    } else {
                        "to"
                    },
                    code(r)
                );
            }
            m.entry(c.kind).or_default().push(s);
        }
        m
    };
    let breaking: Vec<&ComponentDiff> = d
        .components
        .iter()
        .filter(|c| c.status == Status::Changed && c.impact == Impact::Breaking)
        .collect();
    out.push(Block::H(
        2,
        format!("Breaking changes ({})", breaking.len() + t.removed as usize),
    ));
    let removed = by_kind(Status::Removed);
    if !removed.is_empty() {
        out.push(Block::H(3, "Removed".into()));
        for (k, list) in &removed {
            out.push(Block::P(format!(
                "**{}** ({}): {}",
                plural(*k),
                list.len(),
                list.join(", ")
            )));
        }
    }
    for c in &breaking {
        out.push(Block::H(3, heading(c)));
        out.push(Block::List(
            c.changes
                .iter()
                .filter(|x| x.impact == Impact::Breaking)
                .map(change_line)
                .collect(),
        ));
        let other: Vec<String> = c
            .changes
            .iter()
            .filter(|x| x.impact == Impact::NonBreaking)
            .map(change_line)
            .collect();
        if !other.is_empty() {
            out.push(Block::P("Also:".into()));
            out.push(Block::List(other));
        }
    }
    let added = by_kind(Status::Added);
    out.push(Block::H(2, format!("Added ({})", t.added)));
    for (k, list) in &added {
        out.push(Block::P(format!(
            "**{}** ({}): {}",
            plural(*k),
            list.len(),
            list.join(", ")
        )));
    }
    if !d.renames.is_empty() {
        out.push(Block::H(
            2,
            format!("Possibly renamed ({})", d.renames.len()),
        ));
        out.push(Block::Table(
            vec![
                "Kind".into(),
                "Old".into(),
                "New".into(),
                "Similarity".into(),
            ],
            d.renames
                .iter()
                .map(|r| {
                    vec![
                        kind_name(r.kind).into(),
                        code(&r.old.qname),
                        code(&r.new.qname),
                        format!("{}%", r.score),
                    ]
                })
                .collect(),
        ));
    }
    let other: Vec<&ComponentDiff> = d
        .components
        .iter()
        .filter(|c| c.status == Status::Changed && c.impact == Impact::NonBreaking)
        .collect();
    out.push(Block::H(2, format!("Other changes ({})", other.len())));
    for c in &other {
        out.push(Block::H(3, heading(c)));
        out.push(Block::List(
            c.changes
                .iter()
                .filter(|x| x.impact != Impact::Info)
                .map(change_line)
                .collect(),
        ));
    }
    let docs: Vec<String> = d
        .components
        .iter()
        .filter(|c| c.changes.iter().any(|x| x.kind == ChangeKind::DocsChanged))
        .map(|c| code(c.qname()))
        .collect();
    if !docs.is_empty() {
        out.push(Block::H(
            2,
            format!("Documentation changes ({})", docs.len()),
        ));
        out.push(Block::P(docs.join(", ")));
    }
    out.push(Block::P(format!("Generated by {}.", d.generator)));
    out
}

/// A Markdown report, for release notes.
pub fn markdown(d: &SchemaDiff) -> String {
    let mut s = String::new();
    for b in blocks(d) {
        match b {
            Block::H(l, t) => {
                let _ = writeln!(s, "{} {t}\n", "#".repeat(l as usize));
            }
            Block::P(t) => {
                let _ = writeln!(s, "{t}\n");
            }
            Block::List(items) => {
                for i in items {
                    let _ = writeln!(s, "- {}", i.replace('\n', " "));
                }
                s.push('\n');
            }
            Block::Table(head, rows) => {
                let cell = |c: &String| c.replace('|', "\\|");
                let _ = writeln!(
                    s,
                    "| {} |",
                    head.iter().map(cell).collect::<Vec<_>>().join(" | ")
                );
                let numeric = |i: usize| {
                    rows.iter().all(|r| {
                        r.get(i)
                            .is_some_and(|c| c.trim_end_matches('%').parse::<f64>().is_ok())
                    })
                };
                let _ = writeln!(
                    s,
                    "|{}",
                    (0..head.len())
                        .map(|i| if numeric(i) { "---:|" } else { "---|" })
                        .collect::<String>()
                );
                for r in rows {
                    let _ = writeln!(
                        s,
                        "| {} |",
                        r.iter().map(cell).collect::<Vec<_>>().join(" | ")
                    );
                }
                s.push('\n');
            }
        }
    }
    s
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// Render the inline `code` and **bold** spans of a text as HTML.
fn inline(s: &str) -> String {
    let mut out = String::new();
    let mut code = false;
    let mut bold = false;
    let mut rest = s;
    while !rest.is_empty() {
        if let Some(r) = rest.strip_prefix('`') {
            out.push_str(if code { "</code>" } else { "<code>" });
            code = !code;
            rest = r;
        } else if !code && let Some(r) = rest.strip_prefix("**") {
            out.push_str(if bold { "</strong>" } else { "<strong>" });
            bold = !bold;
            rest = r;
        } else {
            let ch = rest.chars().next().unwrap();
            out.push_str(&esc(&ch.to_string()));
            rest = &rest[ch.len_utf8()..];
        }
    }
    if code {
        out.push_str("</code>");
    }
    if bold {
        out.push_str("</strong>");
    }
    out
}

const CSS: &str = ":root{color-scheme:light dark;--bg:#fff;--fg:#1d2330;--muted:#5b6577;--line:#d9dee7;--code:#f2f4f8;--add:#1a7f37;--del:#c62828;--chg:#9a6700}@media (prefers-color-scheme:dark){:root{--bg:#14171d;--fg:#e4e8ef;--muted:#9aa4b5;--line:#2c323d;--code:#1f242d;--add:#56d364;--del:#ff7b72;--chg:#e3b341}}body{background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;max-width:960px;margin:0 auto;padding:16px}h1{font-size:1.6em}h2{border-bottom:1px solid var(--line);padding-bottom:4px;margin-top:2em}h3{font-size:1em;margin:1.4em 0 .4em}code{background:var(--code);padding:1px 4px;border-radius:3px;font-size:.9em;overflow-wrap:anywhere}table{border-collapse:collapse;margin:8px 0;max-width:100%;display:block;overflow-x:auto}th,td{border:1px solid var(--line);padding:4px 10px;text-align:right}th:first-child,td:first-child{text-align:left}ul{padding-left:1.2em}li{margin:2px 0}li.mk{list-style:none;margin-left:-1.2em}.mk b{display:inline-block;width:1.2em}.m-add{color:var(--add)}.m-del{color:var(--del)}.m-chg{color:var(--chg)}strong{color:inherit}li strong{color:var(--del)}";

/// A standalone HTML report (light and dark theme).
pub fn html(d: &SchemaDiff) -> String {
    let bl = blocks(d);
    let title = match bl.first() {
        Some(Block::H(_, t)) => t.clone(),
        _ => "Schema changes".into(),
    };
    let mut s = format!(
        "<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>{}</title><style>{CSS}</style></head><body>\n",
        esc(&title)
    );
    for b in bl {
        match b {
            Block::H(l, t) => {
                let _ = writeln!(s, "<h{l}>{}</h{l}>", inline(&t));
            }
            Block::P(t) => {
                let _ = writeln!(s, "<p>{}</p>", inline(&t));
            }
            Block::List(items) => {
                s.push_str("<ul>\n");
                for i in items {
                    let (cls, mark, text) = match i.split_once(' ') {
                        Some(("+", r)) => ("m-add", "+", r),
                        Some(("−", r)) => ("m-del", "−", r),
                        Some(("~", r)) => ("m-chg", "~", r),
                        _ => ("", "", i.as_str()),
                    };
                    if cls.is_empty() {
                        let _ = writeln!(s, "<li>{}</li>", inline(text));
                    } else {
                        let _ = writeln!(
                            s,
                            "<li class=\"mk\"><b class=\"{cls}\">{mark}</b>{}</li>",
                            inline(text)
                        );
                    }
                }
                s.push_str("</ul>\n");
            }
            Block::Table(head, rows) => {
                s.push_str("<table><thead><tr>");
                for h in head {
                    let _ = write!(s, "<th>{}</th>", inline(&h));
                }
                s.push_str("</tr></thead><tbody>\n");
                for r in rows {
                    s.push_str("<tr>");
                    for c in r {
                        let _ = write!(s, "<td>{}</td>", inline(&c));
                    }
                    s.push_str("</tr>\n");
                }
                s.push_str("</tbody></table>\n");
            }
        }
    }
    s.push_str("</body></html>\n");
    s
}
