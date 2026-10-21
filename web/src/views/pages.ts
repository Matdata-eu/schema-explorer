// One page per component kind: complex type, element, simple type, groups,
// attributes, identity constraints, and a page per file.
import type { AppCtx } from "../ctx";
import { button, h, plural, type Child } from "../dom";
import { buildSimpleGraph } from "../graph";
import { KIND_LABEL, isId, occursText, type ContentRow, type Id, type Ref } from "../model";
import { chip, chips, docBlock, emptyNote, facetList, link, pageHead, refLink, section, shortDoc, sourceSection, whereUsed } from "./common";
import { diagramPanel, smallDiagram, treePanel } from "./diagramPanel";

const card = (...c: Child[]) => h("div", { class: "card", style: { marginBottom: "14px" } }, ...c);

/** The base chain as links: Type ← Base ← Root. */
function baseChain(ctx: AppCtx, id: Id): HTMLElement | null {
  const chain = ctx.m.baseChain(id);
  if (!chain.length) return null;
  const method = (x: Id) => ctx.m.comp(x).complexType?.derivation?.method ?? (ctx.m.comp(x).simpleType?.base !== undefined ? "restriction" : undefined);
  const parts: Child[] = [h("strong", null, ctx.m.label(id))];
  let prev: Id = id;
  for (const r of chain) {
    parts.push(h("span", { class: "faint", title: method(prev) }, method(prev) === "extension" ? " ⟵ extends " : " ⟵ restricts "), refLink(ctx, r));
    if (!isId(r)) break;
    prev = r;
  }
  return h("div", { class: "chain" }, ...parts);
}

/** Tabs between the class diagram and the content tree of a type or element. */
function viewTabs(ctx: AppCtx, id: Id, diagramFor: Id | undefined, treeFor: Id): HTMLElement[] {
  const tab = ctx.route.tab === "tree" || diagramFor === undefined ? "tree" : "diagram";
  const tabs = h(
    "div",
    { class: "btn-group", style: { marginLeft: "auto" } },
    diagramFor !== undefined ? button("Diagram", () => ctx.go(id, { tab: "diagram" }), { icon: "diagram", cls: "small", pressed: tab === "diagram" }) : null,
    button("Content tree", () => ctx.go(id, { tab: "tree" }), { icon: "tree", cls: "small", pressed: tab === "tree" })
  );
  const out = [section(tab === "diagram" ? "Diagram" : "Content tree", { tools: [tabs] })];
  if (tab === "diagram" && diagramFor !== undefined) {
    out.push(diagramPanel(ctx, diagramFor));
    out.push(h("p", { class: "faint hint" }, "Click a box for options; double-click adds its neighbours. Drag to pan, scroll to zoom. A hollow triangle is extension (dashed: restriction), a diamond is a child element with its multiplicity, dashed arrows lead to enumerations."));
  } else {
    out.push(treePanel(ctx, treeFor));
    out.push(h("p", { class: "faint hint" }, "Click + to open an element's content, click a box for its pages. Dashed boxes are optional, stacked boxes repeat; the three-dot node is a sequence, the forked one a choice."));
  }
  return out;
}

/** The sections every complex type has: content model, attributes, facets. */
function typeBody(ctx: AppCtx, tid: Id, page: HTMLElement): void {
  const m = ctx.m;
  const ct = m.comp(tid).complexType!;
  const rows = m.contentRows(tid, { inherited: true });
  const own = rows.filter((r) => r.from === tid && r.kind !== "compositor").length;
  const inh = rows.filter((r) => r.from !== tid && r.kind !== "compositor").length;
  const simple = ct.effective?.simple ?? (ct.derivation?.simple ? ct.derivation.base : undefined);
  if (simple !== undefined) {
    page.append(section("Text content"), card(h("dl", { class: "kv" }, h("dt", null, "Value"), h("dd", null, refLink(ctx, simple)), ct.facets?.length ? [h("dt", null, "Facets"), h("dd", null, facetList(ct.facets))] : null)));
    if (ct.enumerations?.length) page.append(enumTable(ctx, ct.enumerations));
  }
  if (rows.length || simple === undefined) {
    const inhToggle = inh ? h("label", null, h("input", { type: "checkbox", checked: ctx.prefs.showInherited, onChange: (ev: Event) => {
      ctx.setPrefs({ showInherited: (ev.target as HTMLInputElement).checked });
      ctx.refresh();
    } }), `inherited (${inh})`) : null;
    page.append(section("Content model", { count: own + (ctx.prefs.showInherited ? inh : 0), tools: [ct.mixed || ct.effective?.mixed ? h("span", { class: "badge" }, "mixed") : null, inhToggle] }));
    page.append(rows.length ? contentTable(ctx, tid, rows, ctx.prefs.showInherited) : emptyNote(simple !== undefined ? "" : "Empty content: no child elements."));
  }
  const attrs = m.attributes(tid);
  const ownA = attrs.filter((a) => a.from === tid).length;
  page.append(section("Attributes", { count: attrs.length, tools: attrs.length > ownA ? [h("span", { class: "faint small" }, `${attrs.length - ownA} inherited`)] : [] }));
  page.append(attrs.length || ct.effective?.anyAttribute || ct.anyAttribute ? attrTable(ctx, tid, attrs, ct.effective?.anyAttribute ?? ct.anyAttribute) : emptyNote("No attributes."));
  if (ct.asserts?.length) page.append(section("Assertions", { count: ct.asserts.length }), h("ul", { class: "cons" }, ct.asserts.map((a) => h("li", null, h("code", null, a)))));
  // Identity constraints on the child elements.
  const ids: Id[] = [];
  for (const r of rows) if (r.kind === "element" && r.id !== undefined) ids.push(...(m.comp(r.id).element?.identity ?? []));
  if (ids.length) page.append(section("Identity constraints", { count: ids.length }), identityTable(ctx, ids));
}

/** The content model as a table, with compositors as indented header rows. */
export function contentTable(ctx: AppCtx, tid: Id, rows: ContentRow[], showInherited: boolean): HTMLElement {
  const m = ctx.m;
  const table = h("table", { class: "ptable cm" });
  table.appendChild(h("thead", null, h("tr", null, h("th", null, "Element"), h("th", null, "Type"), h("th", null, "Card."), h("th", null, "Documentation"))));
  let body = h("tbody");
  table.appendChild(body);
  let from: Id | undefined;
  for (const r of rows) {
    const inherited = r.from !== tid;
    if (inherited && !showInherited) continue;
    if (r.from !== from) {
      from = r.from;
      if (inherited || rows.some((x) => x.from !== tid)) {
        // A header per contributing type; inherited groups can be folded.
        const n = rows.filter((x) => x.from === r.from && x.kind !== "compositor").length;
        body = h("tbody", { class: inherited ? "inh-group" : "" });
        const head = h("tr", { class: "group-row" }, h("td", { colspan: 4 }, inherited ? h("button", { class: "linkish fold", type: "button", "aria-expanded": "true", onClick: (ev: Event) => {
          const t = (ev.currentTarget as HTMLElement).closest("tbody")!;
          const shut = t.classList.toggle("folded");
          (ev.currentTarget as HTMLElement).setAttribute("aria-expanded", String(!shut));
        } }, "▾ ") : null, inherited ? "Inherited from " : "Declared in ", link(ctx, r.from), h("span", { class: "faint" }, ` · ${plural(n, "element")}`)));
        body.appendChild(head);
        table.appendChild(body);
      }
    }
    body.appendChild(contentRow(ctx, r, inherited));
  }
  void m;
  return table;
}

function contentRow(ctx: AppCtx, r: ContentRow, inherited: boolean): HTMLElement {
  const m = ctx.m;
  const pad = { paddingLeft: `${10 + r.depth * 18}px` };
  const card = occursText(r.min, r.max);
  const cls = `${inherited ? "inherited" : ""}${r.inChoice ? " in-choice" : ""}`;
  if (r.kind === "compositor") {
    return h("tr", { class: `${cls} comp-row` }, h("td", { style: pad, colspan: 2 }, h("span", { class: `compositor c-${r.compositor}` }, r.compositor)), h("td", { class: "mult" }, card), h("td", { class: "faint small" }, r.compositor === "choice" ? "one of the following" : r.compositor === "all" ? "all, in any order" : ""));
  }
  if (r.kind === "group") {
    return h("tr", { class: `${cls} comp-row` }, h("td", { style: pad, colspan: 2 }, h("span", { class: "compositor c-group" }, "group "), r.id !== undefined ? link(ctx, r.id, m.qname(r.id)) : h("span", { class: "missing" }, m.refName(r.missing))), h("td", { class: "mult" }, card), h("td", null, r.id !== undefined ? shortDoc(m.comp(r.id).docs) : null));
  }
  if (r.kind === "any") {
    const w = r.wildcard!;
    return h("tr", { class: cls }, h("td", { style: pad }, h("span", { class: "mono" }, "any")), h("td", { class: "mono small" }, w.namespace ?? "##any", w.processContents ? h("span", { class: "faint" }, ` (${w.processContents})`) : null), h("td", { class: "mult" }, card), h("td", null));
  }
  const id = r.id;
  if (id === undefined) return h("tr", { class: cls }, h("td", { style: pad }, h("span", { class: "missing mono" }, m.refName(r.missing))), h("td"), h("td", { class: "mult" }, card), h("td", { class: "faint" }, "not found"));
  const el = m.comp(id);
  const t = m.elementType(id);
  const isRef = el.parent === undefined;
  const docs = el.docs?.length ? el.docs : isId(t) && m.comp(t).name === "" ? undefined : undefined;
  const typeDoc = !el.docs?.length && isId(t) ? m.comp(t).docs : undefined;
  return h(
    "tr",
    { class: cls },
    h("td", { class: "pname", style: pad }, link(ctx, id, el.name ?? ""), isRef ? h("span", { class: "role", title: "a reference to a global element" }, "ref") : null, el.element?.abstract ? h("span", { class: "role" }, "abstract") : null, (el.element?.members?.length ?? 0) > 0 ? h("span", { class: "role", title: "elements of its substitution group may appear instead" }, `+${el.element!.members!.length} substitutes`) : null),
    h("td", { class: "rng" }, t === undefined ? h("span", { class: "faint" }, "anyType") : isId(t) && !m.comp(t).name ? link(ctx, t, "anonymous") : refLink(ctx, t, true)),
    h("td", { class: "mult" }, card, el.element?.nillable ? h("div", { class: "faint small" }, "nillable") : null),
    h("td", null, docs ? shortDoc(docs) : typeDoc ? h("div", { class: "faint" }, shortDoc(typeDoc)) : null)
  );
}

function attrTable(ctx: AppCtx, owner: Id, attrs: ReturnType<AppCtx["m"]["attributes"]>, any?: { namespace?: string; processContents?: string }): HTMLElement {
  const m = ctx.m;
  const table = h("table", { class: "ptable" }, h("thead", null, h("tr", null, h("th", null, "Attribute"), h("th", null, "Type"), h("th", null, "Use"), h("th", null, "Default / fixed"), h("th", null, "Documentation"))));
  const tbody = h("tbody");
  for (const a of attrs) {
    const decl = isId(a.attr) ? m.comp(a.attr) : undefined;
    const t = m.attrType(a.attr);
    const dflt = a.default ?? decl?.attribute?.default;
    const fixed = a.fixed ?? decl?.attribute?.fixed;
    tbody.appendChild(
      h(
        "tr",
        { class: `${a.from !== owner ? "inherited" : ""}${a.use === "prohibited" ? " prohibited" : ""}` },
        h("td", { class: "pname" }, isId(a.attr) ? link(ctx, a.attr, "@" + (decl?.name ?? "")) : h("span", { class: "missing" }, m.refName(a.attr)), a.from !== owner ? h("div", { class: "faint small" }, "from ", link(ctx, a.from)) : null, a.via !== undefined ? h("div", { class: "faint small" }, "via ", link(ctx, a.via)) : null),
        h("td", { class: "rng" }, t === undefined ? h("span", { class: "faint" }, "anySimpleType") : isId(t) && !m.comp(t).name ? link(ctx, t, "anonymous") : refLink(ctx, t, true)),
        h("td", null, a.use === "required" ? h("strong", null, "required") : a.use === "prohibited" ? h("span", { class: "faint" }, "prohibited") : h("span", { class: "muted" }, "optional")),
        h("td", { class: "mono small" }, fixed !== undefined ? ["fixed ", h("code", null, fixed)] : dflt !== undefined ? h("code", null, dflt) : null),
        h("td", null, decl ? shortDoc(decl.docs) : null)
      )
    );
  }
  if (any) tbody.appendChild(h("tr", null, h("td", { class: "mono" }, "anyAttribute"), h("td", { class: "mono small", colspan: 4 }, any.namespace ?? "##any", any.processContents ? ` (${any.processContents})` : "")));
  table.appendChild(tbody);
  return table;
}

function enumTable(ctx: AppCtx, values: { value: string; docs?: { text: string; lang?: string }[] }[]): HTMLElement {
  void ctx;
  const withDocs = values.some((v) => v.docs?.length);
  const table = h("table", { class: "ptable" }, h("thead", null, h("tr", null, h("th", null, "Value"), withDocs ? h("th", null, "Documentation") : null)));
  const tbody = h("tbody");
  const render = (limit: number) => {
    tbody.replaceChildren();
    for (const v of values.slice(0, limit)) tbody.appendChild(h("tr", null, h("td", { class: "mono" }, v.value), withDocs ? h("td", null, docBlock(v.docs, "desc")) : null));
    if (values.length > limit) tbody.appendChild(h("tr", null, h("td", { colspan: 2 }, h("button", { type: "button", class: "linkish", onClick: () => render(values.length) }, `Show all ${values.length}`))));
  };
  render(300);
  table.appendChild(tbody);
  return h("div", null, section("Enumeration", { count: values.length }), table);
}

function identityTable(ctx: AppCtx, ids: Id[]): HTMLElement {
  const m = ctx.m;
  return h(
    "table",
    { class: "ptable" },
    h("thead", null, h("tr", null, h("th", null, "Name"), h("th", null, "Kind"), h("th", null, "On"), h("th", null, "Selector"), h("th", null, "Fields"))),
    h(
      "tbody",
      null,
      ids.map((id) => {
        const c = m.comp(id);
        return h(
          "tr",
          null,
          h("td", { class: "pname" }, link(ctx, id, c.name ?? ""), c.identity?.refer !== undefined ? h("div", { class: "faint small" }, "refers to ", refLink(ctx, c.identity.refer)) : null),
          h("td", null, KIND_LABEL[c.kind]),
          h("td", null, c.parent !== undefined ? link(ctx, c.parent) : null),
          h("td", { class: "mono small" }, c.identity?.selector ?? ""),
          h("td", { class: "mono small" }, (c.identity?.fields ?? []).join(", "))
        );
      })
    )
  );
}

function flagBadges(flags: [boolean | undefined, string, string?][]): HTMLElement[] {
  return flags.filter(([on]) => on).map(([, text, title]) => h("span", { class: "badge", title }, text));
}

// ---- pages ----------------------------------------------------------------

export function complexTypePage(ctx: AppCtx, id: Id): HTMLElement {
  const m = ctx.m;
  const c = m.comp(id);
  const ct = c.complexType!;
  const page = h("div");
  page.appendChild(pageHead(ctx, id, flagBadges([[ct.abstract, "abstract"], [ct.mixed, "mixed"], [ct.derivation?.simple, "simple content"], [ct.final !== undefined, `final ${ct.final}`], [ct.block !== undefined, `block ${ct.block}`], [c.redefines !== undefined, "redefined"]])));
  const derived = ct.derived ?? [];
  const elements = m.usedBy(id).filter((u) => u.how === "type" && m.comp(u.by).kind === "element" && m.isGlobal(u.by)).map((u) => u.by);
  const chain = baseChain(ctx, id);
  if (chain || derived.length || elements.length || c.parent !== undefined) {
    const dl = h("dl", { class: "kv" });
    if (c.parent !== undefined) dl.append(h("dt", null, "Type of"), h("dd", null, chip(ctx, c.parent)));
    if (chain) dl.append(h("dt", null, "Derivation"), h("dd", null, chain));
    if (derived.length) dl.append(h("dt", null, plural(derived.length, "Derived type")), h("dd", null, chips(ctx, derived, { max: 30 })));
    if (elements.length) dl.append(h("dt", null, plural(elements.length, "Global element")), h("dd", null, chips(ctx, elements, { max: 20 })));
    page.appendChild(card(dl));
  }
  page.append(...viewTabs(ctx, id, id, id));
  typeBody(ctx, id, page);
  const used = whereUsed(ctx, id);
  if (used) page.appendChild(used);
  const src = sourceSection(ctx, id);
  if (src) page.appendChild(src);
  return page;
}

export function elementPage(ctx: AppCtx, id: Id): HTMLElement {
  const m = ctx.m;
  const c = m.comp(id);
  const e = c.element ?? {};
  const page = h("div");
  page.appendChild(pageHead(ctx, id, flagBadges([[e.abstract, "abstract"], [e.nillable, "nillable"], [e.final !== undefined, `final ${e.final}`], [e.block !== undefined, `block ${e.block}`]])));
  const t = m.elementType(id);
  const anon = isId(t) && !m.comp(t).name && m.comp(t).parent === id;
  const dl = h("dl", { class: "kv" });
  dl.append(h("dt", null, "Type"), h("dd", null, t === undefined ? h("span", { class: "faint" }, "xs:anyType (none declared)") : anon ? h("span", null, "anonymous ", KIND_LABEL[m.comp(t as Id).kind].toLowerCase(), m.baseOf(t as Id) !== undefined ? [" based on ", refLink(ctx, m.baseOf(t as Id))] : null) : refLink(ctx, t), e.type === undefined && t !== undefined ? h("span", { class: "faint" }, " (from its substitution group head)") : null));
  if (e.default !== undefined) dl.append(h("dt", null, "Default"), h("dd", null, h("code", null, e.default)));
  if (e.fixed !== undefined) dl.append(h("dt", null, "Fixed"), h("dd", null, h("code", null, e.fixed)));
  if (e.substitutionGroup?.length) dl.append(h("dt", null, "Substitutes for"), h("dd", null, e.substitutionGroup.map((r: Ref) => refLink(ctx, r))));
  if (e.members?.length) dl.append(h("dt", null, plural(e.members.length, "Substitute")), h("dd", null, chips(ctx, e.members, { max: 40 })));
  if (c.parent !== undefined) {
    const owner = m.owner(id);
    dl.append(h("dt", null, "Declared in"), h("dd", null, chip(ctx, owner)));
  }
  page.appendChild(card(dl));
  const complex = m.isComplex(t);
  if (complex) {
    page.append(...viewTabs(ctx, id, t, id));
    if (anon) typeBody(ctx, t, page);
    else page.append(h("p", { class: "muted" }, "The content model and attributes are those of ", link(ctx, t), "."));
  } else if (isId(t) && m.comp(t).kind === "simpleType") {
    const st = m.comp(t).simpleType!;
    if (st.facets?.length) page.append(section("Facets"), card(facetList(st.facets)));
    if (st.enumerations?.length) page.append(enumTable(ctx, st.enumerations));
  }
  if (e.identity?.length) page.append(section("Identity constraints", { count: e.identity.length }), identityTable(ctx, e.identity));
  const used = whereUsed(ctx, id);
  if (used) page.appendChild(used);
  const src = sourceSection(ctx, id);
  if (src) page.appendChild(src);
  return page;
}

export function simpleTypePage(ctx: AppCtx, id: Id): HTMLElement {
  const m = ctx.m;
  const c = m.comp(id);
  const st = c.simpleType!;
  const page = h("div");
  page.appendChild(pageHead(ctx, id, [h("span", { class: "badge" }, st.variety), ...flagBadges([[st.final !== undefined, `final ${st.final}`], [c.builtin, "built in"]])]));
  const dl = h("dl", { class: "kv" });
  const chain = baseChain(ctx, id);
  if (c.parent !== undefined) dl.append(h("dt", null, "Type of"), h("dd", null, chip(ctx, c.parent)));
  if (chain) dl.append(h("dt", null, "Derivation"), h("dd", null, chain));
  if (st.item !== undefined) dl.append(h("dt", null, "List of"), h("dd", null, refLink(ctx, st.item)));
  if (st.members?.length) dl.append(h("dt", null, "Union of"), h("dd", null, st.members.map((r, i) => [i ? " | " : "", refLink(ctx, r)])));
  if (st.derived?.length) dl.append(h("dt", null, plural(st.derived.length, "Derived type")), h("dd", null, chips(ctx, st.derived, { max: 30 })));
  if (dl.childElementCount) page.appendChild(card(dl));
  if (st.facets?.length) page.append(section("Facets", { count: st.facets.length }), card(facetList(st.facets)));
  if (st.enumerations?.length) page.append(enumTable(ctx, st.enumerations));
  if (!c.builtin && (chain || st.derived?.length || c.usedBy?.length)) {
    page.append(section("Diagram"), smallDiagram(ctx, id, () => buildSimpleGraph(m, id), "base, derived types and the types that use it"));
  }
  const used = whereUsed(ctx, id);
  if (used) page.appendChild(used);
  const src = sourceSection(ctx, id);
  if (src) page.appendChild(src);
  return page;
}

export function groupPage(ctx: AppCtx, id: Id): HTMLElement {
  const m = ctx.m;
  const c = m.comp(id);
  const page = h("div");
  page.appendChild(pageHead(ctx, id));
  page.append(section("Content tree"), treePanel(ctx, id));
  const rows: ContentRow[] = [];
  if (c.group) m.particleRows(c.group, id, 0, false, rows, new Set());
  page.append(section("Content model", { count: rows.filter((r) => r.kind === "element").length }), rows.length ? contentTable(ctx, id, rows, true) : emptyNote("Empty group."));
  const used = whereUsed(ctx, id);
  if (used) page.appendChild(used);
  const src = sourceSection(ctx, id);
  if (src) page.appendChild(src);
  return page;
}

export function attributeGroupPage(ctx: AppCtx, id: Id): HTMLElement {
  const m = ctx.m;
  const c = m.comp(id);
  const page = h("div");
  page.appendChild(pageHead(ctx, id));
  const attrs = m.attributes(id);
  page.append(section("Attributes", { count: attrs.length }), attrs.length ? attrTable(ctx, id, attrs, c.attributeGroup?.anyAttribute) : emptyNote("No attributes."));
  const used = whereUsed(ctx, id);
  if (used) page.appendChild(used);
  const src = sourceSection(ctx, id);
  if (src) page.appendChild(src);
  return page;
}

export function attributePage(ctx: AppCtx, id: Id): HTMLElement {
  const m = ctx.m;
  const c = m.comp(id);
  const a = c.attribute ?? {};
  const page = h("div");
  page.appendChild(pageHead(ctx, id, flagBadges([[a.inheritable, "inheritable"], [c.builtin, "built in"]])));
  const dl = h("dl", { class: "kv" });
  dl.append(h("dt", null, "Type"), h("dd", null, a.type === undefined ? h("span", { class: "faint" }, "xs:anySimpleType") : refLink(ctx, a.type)));
  if (a.default !== undefined) dl.append(h("dt", null, "Default"), h("dd", null, h("code", null, a.default)));
  if (a.fixed !== undefined) dl.append(h("dt", null, "Fixed"), h("dd", null, h("code", null, a.fixed)));
  if (c.parent !== undefined) dl.append(h("dt", null, "Declared in"), h("dd", null, chip(ctx, m.owner(id))));
  page.appendChild(card(dl));
  if (isId(a.type) && m.comp(a.type).simpleType?.enumerations?.length) page.append(enumTable(ctx, m.comp(a.type).simpleType!.enumerations!));
  const used = whereUsed(ctx, id);
  if (used) page.appendChild(used);
  const src = sourceSection(ctx, id);
  if (src) page.appendChild(src);
  return page;
}

export function identityPage(ctx: AppCtx, id: Id): HTMLElement {
  const m = ctx.m;
  const c = m.comp(id);
  const page = h("div");
  page.appendChild(pageHead(ctx, id));
  const dl = h("dl", { class: "kv" });
  if (c.parent !== undefined) dl.append(h("dt", null, "On element"), h("dd", null, chip(ctx, c.parent)));
  dl.append(h("dt", null, "Selector"), h("dd", null, h("code", null, c.identity?.selector ?? "")));
  dl.append(h("dt", null, "Fields"), h("dd", null, (c.identity?.fields ?? []).map((f, i) => [i ? ", " : "", h("code", null, f)])));
  if (c.identity?.refer !== undefined) dl.append(h("dt", null, "Refers to"), h("dd", null, refLink(ctx, c.identity.refer)));
  page.appendChild(card(dl));
  const used = whereUsed(ctx, id);
  if (used) page.appendChild(used);
  const src = sourceSection(ctx, id);
  if (src) page.appendChild(src);
  return page;
}

export function componentPage(ctx: AppCtx, id: Id): HTMLElement {
  const c = ctx.m.comp(id);
  switch (c.kind) {
    case "complexType":
      return complexTypePage(ctx, id);
    case "element":
      return elementPage(ctx, id);
    case "simpleType":
      return simpleTypePage(ctx, id);
    case "group":
      return groupPage(ctx, id);
    case "attributeGroup":
      return attributeGroupPage(ctx, id);
    case "attribute":
      return attributePage(ctx, id);
    default:
      return identityPage(ctx, id);
  }
}

/** A schema file: namespace, imports and includes, and what it declares. */
export function filePage(ctx: AppCtx, fid: number): HTMLElement {
  const m = ctx.m;
  const f = m.b.files[fid];
  const page = h("div");
  if (!f) return h("div", null, h("h1", null, "Not found"));
  page.appendChild(h("div", { class: "page-head" }, h("h1", null, f.name.split("/").pop()), h("span", { class: "badge" }, "Schema file"), f.input ? null : h("span", { class: "badge", title: "pulled in through an import or include" }, "imported")));
  page.appendChild(h("div", { class: "iri-line" }, h("span", { class: "mono" }, f.name), f.version ? h("span", { class: "faint" }, `version ${f.version}`) : null));
  const d = docBlock(f.docs);
  if (d) page.appendChild(d);
  const dl = h("dl", { class: "kv" });
  dl.append(h("dt", null, "Target namespace"), h("dd", { class: "mono" }, f.targetNamespace ?? h("span", { class: "faint" }, "none")));
  if (f.namespace !== undefined && m.b.namespaces[f.namespace]?.uri !== f.targetNamespace) dl.append(h("dt", null, "Components in"), h("dd", { class: "mono" }, m.b.namespaces[f.namespace].uri, h("span", { class: "faint" }, " (chameleon include)")));
  dl.append(h("dt", null, "Element form"), h("dd", null, f.elementFormQualified ? "qualified" : "unqualified"));
  page.appendChild(card(dl));
  const dirs = f.directives ?? [];
  if (dirs.length) {
    page.append(
      section("Imports and includes", { count: dirs.length }),
      h(
        "table",
        { class: "ptable compact" },
        h("thead", null, h("tr", null, h("th", null, "Kind"), h("th", null, "Namespace"), h("th", null, "Location"), h("th", null, "File"))),
        h("tbody", null, dirs.map((x) => h("tr", null, h("td", null, x.kind), h("td", { class: "mono small" }, x.namespace ?? ""), h("td", { class: "mono small" }, x.location ?? ""), h("td", null, x.file !== undefined ? h("a", { href: ctx.hrefRoute({ view: "file", id: x.file }), onClick: (ev: Event) => {
          ev.preventDefault();
          ctx.goRoute({ view: "file", id: x.file });
        } }, m.b.files[x.file]?.name ?? "") : h("span", { class: "missing" }, "not found")))))
      )
    );
  }
  const usedBy = m.b.files.map((g, i) => ({ g, i })).filter(({ g }) => (g.directives ?? []).some((x) => x.file === fid));
  if (usedBy.length) page.append(section("Imported or included by", { count: usedBy.length }), h("ul", { class: "plain" }, usedBy.map(({ g, i }) => h("li", null, h("a", { href: ctx.hrefRoute({ view: "file", id: i }), onClick: (ev: Event) => {
    ev.preventDefault();
    ctx.goRoute({ view: "file", id: i });
  } }, g.name)))));
  const here: Id[] = [];
  for (let i = 0; i < m.c.length; i++) if (m.c[i].file === fid && m.c[i].parent === undefined) here.push(i);
  here.sort((a, b) => (m.c[a].line ?? 0) - (m.c[b].line ?? 0));
  const byKind = new Map<string, Id[]>();
  for (const id of here) {
    const k = m.c[id].kind;
    byKind.set(k, [...(byKind.get(k) ?? []), id]);
  }
  for (const [k, ids] of byKind) page.append(section(`${KIND_LABEL[k as keyof typeof KIND_LABEL]}s`, { count: ids.length }), chips(ctx, ids, { max: 80 }));
  const diags = (m.b.diagnostics ?? []).filter((x) => x.file === fid && x.level !== "info");
  if (diags.length) page.append(section("Problems", { count: diags.length }), h("ul", { class: "diags" }, diags.map((x) => h("li", { class: x.level }, h("span", { class: "badge" }, x.level), ` line ${x.line ?? "?"}: ${x.message}`))));
  return page;
}
