//! Derived indexes: where used, derived types, substitution group members,
//! effective content models and the search index.

use crate::bundle::*;
use std::collections::{BTreeMap, HashSet};

/// Fill `used_by`, `derived` and `members`.
pub(crate) fn links(components: &mut [Component], usages: Vec<(Id, Usage)>) {
    for (target, u) in usages {
        let list = &mut components[target as usize].used_by;
        if list.last() != Some(&u) {
            list.push(u);
        }
    }
    let mut derived: Vec<(Id, Id)> = Vec::new();
    let mut members: Vec<(Id, Id)> = Vec::new();
    for (i, c) in components.iter().enumerate() {
        let i = i as Id;
        let base = c
            .complex_type
            .as_ref()
            .and_then(|ct| ct.derivation.as_ref())
            .and_then(|d| d.base.id())
            .or_else(|| {
                c.simple_type
                    .as_ref()
                    .and_then(|st| st.base.as_ref())
                    .and_then(Ref::id)
            });
        if let Some(b) = base {
            derived.push((b, i));
        }
        if let Some(e) = &c.element {
            for h in e.substitution_group.iter().filter_map(Ref::id) {
                members.push((h, i));
            }
        }
    }
    for (b, d) in derived {
        let c = &mut components[b as usize];
        if let Some(ct) = &mut c.complex_type {
            ct.derived.push(d);
        } else if let Some(st) = &mut c.simple_type {
            st.derived.push(d);
        }
    }
    for (h, m) in members {
        if let Some(e) = &mut components[h as usize].element {
            e.members.push(m);
        }
    }
}

#[derive(Clone)]
enum State {
    Todo,
    Busy,
    Done(Box<Effective>),
}

/// Compute the effective content model of every complex type.
pub(crate) fn effective(components: &mut [Component], diags: &mut Vec<Diagnostic>) {
    let mut memo: Vec<State> = vec![State::Todo; components.len()];
    for i in 0..components.len() {
        if components[i].complex_type.is_some() {
            compute(components, i as Id, &mut memo, diags);
        }
    }
    for (i, s) in memo.into_iter().enumerate() {
        if let (State::Done(e), Some(ct)) = (s, &mut components[i].complex_type) {
            ct.effective = Some(*e);
        }
    }
}

fn attr_key(components: &[Component], r: &Ref) -> (Option<NsId>, String) {
    match r {
        Ref::Id(a) => {
            let c = &components[*a as usize];
            (c.ns, c.name.clone())
        }
        Ref::Missing(s) => (None, s.clone()),
    }
}

/// Expand attribute items (attribute groups inlined) declared by `from`.
fn expand(
    components: &[Component],
    items: &[AttrItem],
    from: Id,
    via: Option<Id>,
    seen: &mut HashSet<Id>,
    out: &mut Vec<EffectiveAttr>,
    any: &mut Option<Wildcard>,
) {
    for it in items {
        match it {
            AttrItem::Attribute {
                attr,
                r#use,
                default,
                fixed,
            } => {
                let (default, fixed) = match (default, fixed, attr.id()) {
                    (None, None, Some(a)) => components[a as usize]
                        .attribute
                        .as_ref()
                        .map_or((None, None), |i| (i.default.clone(), i.fixed.clone())),
                    _ => (default.clone(), fixed.clone()),
                };
                out.push(EffectiveAttr {
                    attr: attr.clone(),
                    r#use: *r#use,
                    default,
                    fixed,
                    from,
                    via,
                });
            }
            AttrItem::Group { group } => {
                let Some(g) = group.id() else { continue };
                if !seen.insert(g) {
                    continue;
                }
                if let Some(info) = &components[g as usize].attribute_group {
                    expand(
                        components,
                        &info.attributes,
                        from,
                        via.or(Some(g)),
                        seen,
                        out,
                        any,
                    );
                    if any.is_none() {
                        any.clone_from(&info.any_attribute);
                    }
                }
                seen.remove(&g);
            }
        }
    }
}

fn compute(
    components: &[Component],
    id: Id,
    memo: &mut Vec<State>,
    diags: &mut Vec<Diagnostic>,
) -> Option<Effective> {
    match &memo[id as usize] {
        State::Done(e) => return Some((**e).clone()),
        State::Busy => {
            let c = &components[id as usize];
            diags.push(Diagnostic {
                level: Level::Warning,
                code: "cycle".into(),
                message: format!("type {} derives from itself", c.name),
                file: c.file,
                line: c.line,
            });
            return None;
        }
        State::Todo => {}
    }
    let ct = components[id as usize].complex_type.as_ref()?;
    memo[id as usize] = State::Busy;
    let mut own = Vec::new();
    let mut own_any = None;
    expand(
        components,
        &ct.attributes,
        id,
        None,
        &mut HashSet::new(),
        &mut own,
        &mut own_any,
    );
    if ct.any_attribute.is_some() {
        own_any.clone_from(&ct.any_attribute);
    }
    let base = ct.derivation.as_ref().and_then(|d| d.base.id());
    let base_eff = base
        .filter(|b| components[*b as usize].complex_type.is_some())
        .and_then(|b| compute(components, b, memo, diags))
        .unwrap_or(Effective {
            content: Vec::new(),
            attributes: Vec::new(),
            any_attribute: None,
            simple: None,
            mixed: false,
        });
    let own_content = ct.content.is_some().then_some(id);
    let mut e = Effective {
        content: Vec::new(),
        attributes: base_eff.attributes,
        any_attribute: None,
        simple: None,
        mixed: ct.mixed,
    };
    match &ct.derivation {
        None => {
            e.content.extend(own_content);
        }
        Some(d) if d.simple => {
            e.simple = match d.base.id() {
                Some(b) if components[b as usize].simple_type.is_some() => Some(d.base.clone()),
                _ => base_eff.simple,
            };
            if d.method == Method::Restriction
                && !(ct.facets.is_empty() && ct.enumerations.is_empty())
            {
                e.simple = Some(Ref::Id(id));
            }
            e.any_attribute = base_eff.any_attribute.clone();
        }
        Some(d) if d.method == Method::Extension => {
            e.content = base_eff.content;
            e.content.extend(own_content);
            e.mixed |= base_eff.mixed;
            e.any_attribute = base_eff.any_attribute.clone();
        }
        Some(_) => {
            e.content.extend(own_content);
        }
    }
    for a in own {
        let key = attr_key(components, &a.attr);
        let pos = e
            .attributes
            .iter()
            .position(|x| attr_key(components, &x.attr) == key);
        match (pos, a.r#use) {
            (Some(p), AttrUse::Prohibited) => {
                e.attributes.remove(p);
            }
            (None, AttrUse::Prohibited) => {}
            (Some(p), _) => e.attributes[p] = a,
            (None, _) => e.attributes.push(a),
        }
    }
    if own_any.is_some() {
        e.any_attribute = own_any;
    }
    memo[id as usize] = State::Done(Box::new(e.clone()));
    Some(e)
}

const STOP: &[&str] = &[
    "the", "and", "for", "are", "this", "that", "with", "from", "which", "not", "can", "may",
    "has", "have", "its", "was", "were", "will", "shall", "into", "all", "any", "but", "one",
    "used", "use", "type", "element", "value", "values", "see", "also", "other", "only", "when",
    "where", "should", "must", "than", "then", "there", "these", "those", "such", "their", "been",
    "being", "each", "does", "per",
];

/// Lower-case parts of a name: the name itself and its camelCase, `_`,
/// `-` and `.` separated words.
pub fn name_terms(name: &str) -> Vec<String> {
    let mut out = vec![name.to_lowercase()];
    let mut word = String::new();
    let chars: Vec<char> = name.chars().collect();
    for (i, &ch) in chars.iter().enumerate() {
        let boundary = !ch.is_alphanumeric()
            || (ch.is_uppercase()
                && i > 0
                && (chars[i - 1].is_lowercase()
                    || chars.get(i + 1).is_some_and(|n| n.is_lowercase())))
            || (ch.is_ascii_digit()
                != chars
                    .get(i.wrapping_sub(1))
                    .is_some_and(|p| p.is_ascii_digit())
                && i > 0);
        if boundary && !word.is_empty() {
            out.push(std::mem::take(&mut word).to_lowercase());
        }
        if ch.is_alphanumeric() {
            word.push(ch);
        }
    }
    if !word.is_empty() {
        out.push(word.to_lowercase());
    }
    out.retain(|w| w.chars().count() >= 2);
    out.sort();
    out.dedup();
    out
}

fn doc_terms(text: &str, out: &mut Vec<String>) {
    for w in text.split(|c: char| !c.is_alphanumeric()) {
        if w.chars().count() < 3 || w.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let w = w.to_lowercase();
        if !STOP.contains(&w.as_str()) {
            out.push(w);
        }
    }
}

/// Build the search index over names, documentation and enumerations.
pub(crate) fn search(components: &[Component]) -> BTreeMap<String, Vec<Id>> {
    let mut index: BTreeMap<String, Vec<Id>> = BTreeMap::new();
    let mut terms = Vec::new();
    for (i, c) in components.iter().enumerate() {
        if c.builtin {
            continue;
        }
        terms.clear();
        if !c.name.is_empty() {
            terms.extend(name_terms(&c.name));
        }
        for d in &c.docs {
            doc_terms(&d.text, &mut terms);
        }
        let enums = c
            .simple_type
            .as_ref()
            .map(|s| &s.enumerations)
            .or(c.complex_type.as_ref().map(|s| &s.enumerations));
        for e in enums.into_iter().flatten() {
            terms.extend(name_terms(&e.value));
            for d in &e.docs {
                doc_terms(&d.text, &mut terms);
            }
        }
        terms.sort();
        terms.dedup();
        for t in &terms {
            index.entry(t.clone()).or_default().push(i as Id);
        }
    }
    index
}

pub(crate) fn stats(b: &Bundle, unresolved_refs: u32) -> Stats {
    let mut s = Stats {
        files: b.files.len() as u32,
        unresolved_refs,
        unresolved_imports: b.unresolved_imports().count() as u32,
        ..Default::default()
    };
    for c in &b.components {
        if c.builtin {
            continue;
        }
        let map = if c.is_global() && !c.kind.is_identity() {
            &mut s.global
        } else {
            &mut s.local
        };
        *map.entry(c.kind).or_default() += 1;
        s.enumerations += c
            .simple_type
            .as_ref()
            .map_or(0, |st| st.enumerations.len() as u32);
    }
    s
}

#[cfg(test)]
mod tests {
    use super::name_terms;

    #[test]
    fn terms() {
        assert_eq!(
            name_terms("StopPlaceRef_VersionStructure"),
            vec![
                "place",
                "ref",
                "stop",
                "stopplaceref_versionstructure",
                "structure",
                "version"
            ]
        );
        assert_eq!(name_terms("XMLSchema"), vec!["schema", "xml", "xmlschema"]);
    }
}
