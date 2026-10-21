// Compare mode: the overview of what changed between two versions of a
// schema set, and a page per changed component with both versions side by side.
import type { AppCtx } from "../ctx";
import { button, downloadBlob, h, plural, type Child } from "../dom";
import { MARKER, STATUS_LABEL, changeLabel, changeMark, type Change, type Compare, type ComponentDiff, type Counts, type Impact, type Mark, type Status } from "../diff";
import { diffReport } from "../loader";
import { KIND_LABEL, KIND_SLUG, docsText, isId, occursText, type Id, type Kind, type Model } from "../model";
import { section } from "./common";

const KINDS: Kind[] = ["complexType", "simpleType", "element", "attribute", "group", "attributeGroup"];

/** A +/−/~ marker; colour is a second cue, never the only one. */
export function mark(m: Mark, title?: string): HTMLElement {
  return h("span", { class: `dmark d-${m}`, title: title ?? STATUS_LABEL[m], "aria-label": STATUS_LABEL[m] }, MARKER[m]);
}

function impactBadge(i: Impact): HTMLElement | null {
  if (i === "breaking") return h("span", { class: "badge danger" }, "breaking");
  if (i === "info") return h("span", { class: "badge" }, "docs only");
  return null;
}

const qnameOf = (c: ComponentDiff) => c.new?.qname ?? c.old?.qname ?? c.name;

export function diffHref(ctx: AppCtx, c: ComponentDiff): string {
  return ctx.hrefRoute({ view: "diffc", query: `${KIND_SLUG[c.kind]}/${qnameOf(c)}` });
}

function diffLink(ctx: AppCtx, c: ComponentDiff, text?: string): HTMLElement {
  return h("a", { class: text ? "" : `mono d-${c.status}-text`, href: diffHref(ctx, c), onClick: (ev: Event) => {
    const me = ev as MouseEvent;
    if (me.metaKey || me.ctrlKey || me.shiftKey) return;
    ev.preventDefault();
    ctx.goRoute({ view: "diffc", query: `${KIND_SLUG[c.kind]}/${qnameOf(c)}` });
  } }, text ?? qnameOf(c));
}

function countsTable(rows: [string, Counts][]): HTMLElement {
  const n = (v: number, m?: Mark) => h("td", { class: "num" }, v ? [m ? mark(m) : null, " ", v.toLocaleString()] : h("span", { class: "faint" }, "0"));
  return h(
    "table",
    { class: "ptable counts" },
    h("thead", null, h("tr", null, h("th", null, ""), h("th", { class: "num" }, "Added"), h("th", { class: "num" }, "Removed"), h("th", { class: "num" }, "Changed"), h("th", { class: "num" }, "Breaking"))),
    h("tbody", null, rows.map(([label, c]) => h("tr", null, h("td", { class: "mono" }, label), n(c.added, "added"), n(c.removed, "removed"), n(c.changed, "changed"), h("td", { class: "num" }, c.breaking ? h("strong", { class: "d-removed-text" }, c.breaking.toLocaleString()) : h("span", { class: "faint" }, "0")))))
  );
}

/** The namespace a component counts under: a removed one's old namespace maps to the new one. */
function nsOf(cmp: Compare, c: ComponentDiff): string {
  const u = c.namespace ?? "";
  return c.status === "removed" ? cmp.d.namespaceMap?.[u] ?? u : u;
}

function changeSummary(c: ComponentDiff): Child {
  if (c.status === "added") return h("span", { class: "faint" }, "new");
  if (c.status === "removed") return c.possiblyRenamed ? h("span", null, "possibly renamed to ", h("code", null, c.possiblyRenamed)) : h("span", { class: "faint" }, "removed");
  const ch = c.changes ?? [];
  const kinds = new Map<string, number>();
  for (const x of ch) kinds.set(x.kind, (kinds.get(x.kind) ?? 0) + 1);
  const parts = [...kinds].slice(0, 4).map(([k, n]) => `${changeLabel(k)}${n > 1 ? ` ×${n}` : ""}`);
  return h("span", { class: "muted small" }, parts.join(" · ") + (kinds.size > 4 ? " …" : ""));
}

async function download(cmp: Compare, format: "md" | "html" | "json"): Promise<void> {
  const name = `schema-diff.${format}`;
  const text = format === "json" ? JSON.stringify(cmp.d, null, 2) : await diffReport({ ...cmp.d, old: { ...cmp.d.old, title: cmp.oldTitle }, new: { ...cmp.d.new, title: cmp.newTitle } }, format);
  const type = format === "json" ? "application/json" : format === "md" ? "text/markdown" : "text/html";
  downloadBlob(new Blob([text], { type }), name);
}

/** The overview of all changes, with filters kept in the link. */
export function diffOverviewPage(ctx: AppCtx, cmp: Compare): HTMLElement {
  const d = cmp.d;
  const P = ctx.route.params;
  const t = d.summary.total;
  const page = h("div", { class: "diff-page" });
  page.appendChild(h("header", { class: "page-head" }, h("h1", null, "Changes from ", h("span", { class: "d-removed-text" }, cmp.oldTitle), " to ", h("span", { class: "d-added-text" }, cmp.newTitle)), h("p", { class: "lead" }, `${plural(t.added + t.removed + t.changed, "global component")} differ: ${t.added.toLocaleString()} added, ${t.removed.toLocaleString()} removed, ${t.changed.toLocaleString()} changed. ${plural(d.summary.breakingChanges, "breaking change")} in ${plural(t.breaking, "component")}; ${plural(t.docsOnly, "component")} changed only in their documentation.`)));
  const filter = { st: P.st ?? "", k: P.k ?? "", imp: P.imp ?? "", ns: P.ns ?? "", q: P.q ?? "" };
  const stat = (label: string, value: number, m: Mark | null, set: Partial<typeof filter>, cls = "") =>
    h("button", { type: "button", class: `stat ${cls}`, onClick: () => {
      Object.assign(filter, { st: "", imp: "" }, set);
      apply();
    } }, h("span", { class: "n" }, m ? mark(m) : null, " ", value.toLocaleString()), h("span", { class: "l" }, label));
  page.appendChild(
    h(
      "div",
      { class: "stats" },
      stat("added", t.added, "added", { st: "added" }),
      stat("removed", t.removed, "removed", { st: "removed" }),
      stat("changed", t.changed, "changed", { st: "changed" }),
      stat("breaking", t.breaking, null, { imp: "breaking" }, "stat-breaking"),
      stat("docs only", t.docsOnly, null, { imp: "info" }),
      stat("possibly renamed", d.summary.possiblyRenamed, null, { st: "renamed" })
    )
  );
  const nsMap = Object.entries(d.namespaceMap ?? {});
  if (nsMap.length) page.appendChild(h("div", { class: "card note-card" }, h("strong", null, "The target namespace changed. "), "Components were matched by kind and local name: ", nsMap.map(([a, b], i) => [i ? "; " : "", h("code", null, a), " → ", h("code", null, b)])));
  const tools = h("div", { class: "btn-group" }, button("Markdown", () => void download(cmp, "md"), { icon: "download", cls: "small", title: "Release notes as Markdown" }), button("HTML", () => void download(cmp, "html"), { cls: "small", title: "A standalone HTML report" }), button("JSON", () => void download(cmp, "json"), { cls: "small", title: "The diff model" }));
  page.appendChild(section("Summary", { tools: [tools] }));
  const kindRows: [string, Counts][] = KINDS.filter((k) => d.summary.byKind[k]).map((k) => [KIND_LABEL[k], d.summary.byKind[k]!]);
  kindRows.push(["Total", t]);
  const grid = h("div", { class: "grid-2 diff-sum" }, h("div", null, countsTable(kindRows)));
  const nsRows = Object.entries(d.summary.byNamespace);
  if (nsRows.length > 1) grid.appendChild(h("div", null, countsTable(nsRows.map(([k, c]) => [k || "(no namespace)", c]))));
  page.appendChild(grid);
  const files = Object.entries(d.summary.byFile);
  if (files.length > 1) page.appendChild(h("details", { class: "card by-file" }, h("summary", null, `By file (${files.length})`), countsTable(files.map(([k, c]) => [k || "(none)", c]))));

  // Filters.
  const opt = (v: string, label: string, cur: string) => h("option", { value: v, selected: v === cur }, label);
  const q = h("input", { class: "input", type: "search", placeholder: "Filter by name…", value: filter.q, "aria-label": "Filter by name" }) as HTMLInputElement;
  const st = h("select", { class: "input", "aria-label": "Status" }, opt("", "Any status", filter.st), (["added", "removed", "changed", "renamed"] as const).map((s) => opt(s, s === "renamed" ? "Possibly renamed" : STATUS_LABEL[s as Status], filter.st))) as HTMLSelectElement;
  const k = h("select", { class: "input", "aria-label": "Kind" }, opt("", "Any kind", filter.k), KINDS.filter((x) => d.summary.byKind[x]).map((x) => opt(KIND_SLUG[x], KIND_LABEL[x], filter.k))) as HTMLSelectElement;
  const imp = h("select", { class: "input", "aria-label": "Impact" }, opt("", "Any impact", filter.imp), opt("breaking", "Breaking", filter.imp), opt("nonBreaking", "Non-breaking", filter.imp), opt("info", "Documentation only", filter.imp)) as HTMLSelectElement;
  const nsSel = h("select", { class: "input", "aria-label": "Namespace" }, opt("", "Any namespace", filter.ns), nsRows.map(([u]) => opt(u, u || "(no namespace)", filter.ns))) as HTMLSelectElement;
  const count = h("span", { class: "count" });
  page.appendChild(h("div", { class: "section-title" }, h("span", null, "Changes"), count));
  page.appendChild(h("div", { class: "filters" }, q, st, k, imp, nsRows.length > 1 ? nsSel : null));
  const list = h("div", { class: "diff-list" });
  page.appendChild(list);
  let limit = 400;
  const render = () => {
    const needle = filter.q.trim().toLowerCase();
    const rows = d.components.filter(
      (c) =>
        (!filter.st || (filter.st === "renamed" ? !!c.possiblyRenamed : c.status === filter.st)) &&
        (!filter.k || KIND_SLUG[c.kind] === filter.k) &&
        (!filter.imp || c.impact === filter.imp) &&
        (!filter.ns || nsOf(cmp, c) === filter.ns) &&
        (!needle || qnameOf(c).toLowerCase().includes(needle) || (c.old?.qname ?? "").toLowerCase().includes(needle))
    );
    count.textContent = rows.length.toLocaleString();
    const table = h("table", { class: "ptable diff-table" }, h("thead", null, h("tr", null, h("th", null, h("span", { class: "sr-only" }, "Status")), h("th", null, "Component"), h("th", null, "Kind"), h("th", null, "What changed"), h("th", null, "Impact"))));
    const body = h("tbody");
    for (const c of rows.slice(0, limit)) {
      body.appendChild(h("tr", { class: `d-${c.status}` }, h("td", null, mark(c.status)), h("td", null, diffLink(ctx, c), c.byLocalName && c.old && c.old.qname !== c.new?.qname ? h("div", { class: "faint small" }, "was ", c.old.qname) : null), h("td", null, h("span", { class: `badge k-${c.kind}` }, KIND_LABEL[c.kind])), h("td", null, changeSummary(c)), h("td", null, impactBadge(c.impact) ?? h("span", { class: "faint small" }, "non-breaking"))));
    }
    table.appendChild(body);
    list.replaceChildren(rows.length ? table : h("p", { class: "muted" }, "No change matches the filters."));
    if (rows.length > limit) list.appendChild(button(`Show all ${rows.length.toLocaleString()}`, () => {
      limit = rows.length;
      render();
    }, { cls: "small" }));
  };
  const apply = () => {
    q.value = filter.q;
    st.value = filter.st;
    k.value = filter.k;
    imp.value = filter.imp;
    nsSel.value = filter.ns;
    ctx.setParams({ ...filter });
    render();
  };
  q.addEventListener("input", () => {
    filter.q = q.value;
    apply();
  });
  for (const [el, key] of [[st, "st"], [k, "k"], [imp, "imp"], [nsSel, "ns"]] as const)
    el.addEventListener("change", () => {
      filter[key] = el.value;
      apply();
    });
  render();
  return page;
}

// ---- one component ---------------------------------------------------------

interface Line {
  key: string;
  name: string;
  detail: string;
  /** Section header (inherited from …). */
  group?: string;
}

/** The type whose content and attributes describe a component. */
function typeOf(m: Model, id: Id): Id | undefined {
  const c = m.comp(id);
  if (c.kind === "complexType" || c.kind === "simpleType") return id;
  if (c.kind === "element") {
    const t = m.elementType(id);
    return isId(t) ? t : undefined;
  }
  if (c.kind === "attribute") {
    const t = c.attribute?.type;
    return isId(t) ? t : undefined;
  }
  return undefined;
}

function contentLines(m: Model, id: Id): Line[] {
  const c = m.comp(id);
  const out: Line[] = [];
  if (c.kind === "group" && c.group) {
    const rows: ReturnType<Model["contentRows"]> = [];
    m.particleRows(c.group, id, 0, false, rows, new Set());
    return rowsToLines(m, rows, id);
  }
  const t = typeOf(m, id);
  if (t === undefined || m.comp(t).kind !== "complexType") return out;
  return rowsToLines(m, m.contentRows(t, { inherited: true }), t);
}

function rowsToLines(m: Model, rows: ReturnType<Model["contentRows"]>, own: Id): Line[] {
  const out: Line[] = [];
  const seen = new Map<string, number>();
  for (const r of rows) {
    const indent = "  ".repeat(r.depth);
    let name: string;
    let detail: string;
    if (r.kind === "compositor") {
      name = `${indent}${m.b.language === "jsonSchema" ? (r.compositor === "choice" ? (r.max === null ? "anyOf" : "oneOf") : "properties") : r.compositor}`;
      detail = occursText(r.min, r.max);
    } else if (r.kind === "any") {
      name = `${indent}any`;
      detail = `${r.wildcard?.namespace ?? "##any"} ${occursText(r.min, r.max)}`;
    } else if (r.kind === "group") {
      name = `${indent}group ${r.id !== undefined ? m.qname(r.id) : m.refName(r.missing)}`;
      detail = occursText(r.min, r.max);
    } else {
      const local = r.id !== undefined ? m.comp(r.id).name ?? "" : m.refName(r.missing);
      name = `${indent}${local}`;
      const t = r.id !== undefined ? m.elementType(r.id) : undefined;
      detail = `${m.typeName(t) || ""} ${occursText(r.min, r.max)}`.trim();
    }
    const base = r.kind === "element" ? name.trim() : name;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    out.push({ key: n > 1 ? `${base}#${n}` : base, name, detail, group: r.from !== own ? `from ${m.label(r.from)}` : undefined });
  }
  return out;
}

function attrLines(m: Model, id: Id): Line[] {
  const c = m.comp(id);
  if (c.kind === "attributeGroup") {
    return (c.attributeGroup?.attributes ?? []).map((a) => {
      if (a.t === "group") return { key: `group ${m.refName(a.group)}`, name: `attributeGroup ${m.refName(a.group)}`, detail: "" };
      const name = isId(a.attr) ? m.comp(a.attr).name ?? "" : m.refName(a.attr);
      const t = m.attrType(a.attr);
      return { key: name, name: `@${name}`, detail: `${m.typeName(t)} ${a.use ?? "optional"}${a.default !== undefined ? ` = ${a.default}` : ""}${a.fixed !== undefined ? ` fixed ${a.fixed}` : ""}` };
    });
  }
  const t = typeOf(m, id);
  if (t === undefined || m.comp(t).kind !== "complexType") return [];
  return m.attributes(t).map((a) => {
    const name = isId(a.attr) ? m.comp(a.attr).name ?? "" : m.refName(a.attr);
    return { key: name, name: `@${name}`, detail: `${m.typeName(m.attrType(a.attr))} ${a.use ?? "optional"}${a.default !== undefined ? ` = ${a.default}` : ""}${a.fixed !== undefined ? ` fixed ${a.fixed}` : ""}`, group: a.from !== t ? `from ${m.label(a.from)}` : undefined };
  });
}

function enumLines(m: Model, id: Id): Line[] {
  const t = typeOf(m, id);
  return t === undefined ? [] : m.enumerations(t).map((e) => ({ key: e.value, name: e.value, detail: "" }));
}

function facetLines(m: Model, id: Id): Line[] {
  const t = typeOf(m, id);
  if (t === undefined) return [];
  const c = m.comp(t);
  const out: Line[] = [];
  const base = c.simpleType?.base ?? c.complexType?.derivation?.base;
  if (base !== undefined) out.push({ key: "base", name: "base", detail: m.refName(base) });
  for (const f of c.simpleType?.facets ?? c.complexType?.facets ?? []) out.push({ key: `${f.kind} ${f.value}`, name: f.kind, detail: f.value });
  return out;
}

/** Two columns of lines; what differs is marked on both sides. */
function sideBySide(title: string, a: Line[], b: Line[], labels: [string, string]): HTMLElement | null {
  if (!a.length && !b.length) return null;
  const ma = new Map(a.map((l) => [l.key, l]));
  const mb = new Map(b.map((l) => [l.key, l]));
  const col = (lines: Line[], other: Map<string, Line>, gone: Mark, head: string) => {
    const body = h("tbody");
    let group: string | undefined;
    for (const l of lines) {
      if (l.group !== group) {
        group = l.group;
        if (group) body.appendChild(h("tr", { class: "group-row" }, h("td", { colspan: 3 }, group)));
      }
      const o = other.get(l.key);
      const st: Mark | undefined = !o ? gone : o.detail !== l.detail ? "changed" : undefined;
      body.appendChild(h("tr", { class: st ? `d-row d-${st}` : "" }, h("td", { class: "mk" }, st ? mark(st) : null), h("td", { class: "mono pre" }, l.name), h("td", { class: "mono faint" }, l.detail)));
    }
    if (!lines.length) body.appendChild(h("tr", null, h("td", { colspan: 3, class: "faint" }, "(none)")));
    return h("div", { class: "side" }, h("div", { class: "side-head" }, head), h("table", { class: "ptable side-table" }, body));
  };
  const n = b.filter((l) => !ma.has(l.key)).length + a.filter((l) => !mb.has(l.key)).length + b.filter((l) => ma.has(l.key) && ma.get(l.key)!.detail !== l.detail).length;
  return h("div", null, section(title, { count: n || undefined }), h("div", { class: "sbs" }, col(a, mb, "removed", labels[0]), col(b, ma, "added", labels[1])));
}

function changeRow(c: Change): HTMLElement {
  const m = changeMark(c.kind);
  const val = (v: string | undefined) => (v === undefined ? h("span", { class: "faint" }, "—") : h("code", null, v.length > 160 ? v.slice(0, 160) + "…" : v));
  const values = c.kind === "docsChanged" ? h("span", { class: "faint small" }, "see Documentation below") : c.old !== undefined || c.new !== undefined ? h("span", null, val(c.old), " → ", val(c.new)) : null;
  return h("tr", { class: `d-row d-${m}` }, h("td", { class: "mk" }, mark(m)), h("td", null, changeLabel(c.kind)), h("td", { class: "mono" }, c.path ? h("span", { class: "faint" }, c.path + " › ") : null, c.subject ?? ""), h("td", null, values), h("td", null, impactBadge(c.impact) ?? h("span", { class: "faint small" }, "non-breaking")));
}

/** One changed, added or removed component with both versions side by side. */
export function diffComponentPage(ctx: AppCtx, cmp: Compare, c: ComponentDiff): HTMLElement {
  const page = h("div", { class: "diff-page" });
  const back = h("a", { href: ctx.hrefRoute({ view: "diff" }), onClick: (ev: Event) => {
    ev.preventDefault();
    ctx.goRoute({ view: "diff" });
  } }, "All changes");
  page.appendChild(h("div", { class: "crumbs" }, back, h("span", { class: "sep" }, "›"), h("span", null, qnameOf(c))));
  const open = c.new ? button(`Open in ${cmp.newTitle}`, () => ctx.go(c.new!.id), { icon: "external", cls: "small" }) : null;
  page.appendChild(
    h(
      "header",
      { class: "page-head" },
      h("div", { class: "head-main" }, h("div", { class: "badges" }, h("span", { class: `badge k-${c.kind}` }, KIND_LABEL[c.kind]), h("span", { class: `badge d-badge d-${c.status}` }, MARKER[c.status], " ", STATUS_LABEL[c.status]), impactBadge(c.impact), c.byLocalName ? h("span", { class: "badge", title: "matched by local name: the namespace changed" }, "matched by name") : null),
      h("h1", { class: `mono d-${c.status}-text` }, qnameOf(c)),
      c.old && c.new && c.old.qname !== c.new.qname ? h("p", { class: "muted" }, "Was ", h("code", null, c.old.qname), ` in ${cmp.oldTitle}.`) : null,
      c.possiblyRenamed ? h("p", null, c.status === "removed" ? "Possibly renamed to " : "Possibly renamed from ", diffTarget(ctx, cmp, c), " (near-identical content).") : null,
      h("p", { class: "muted small" }, [c.old ? `${cmp.oldTitle}: ${c.old.file ?? ""}${c.old.line ? `:${c.old.line}` : ""}` : null, c.old && c.new ? " · " : null, c.new ? `${cmp.newTitle}: ${c.new.file ?? ""}${c.new.line ? `:${c.new.line}` : ""}` : null]),
      open)
    )
  );
  const ch = c.changes ?? [];
  if (ch.length) {
    const sorted = [...ch].sort((a, b) => (a.impact === b.impact ? 0 : a.impact === "breaking" ? -1 : b.impact === "breaking" ? 1 : a.impact === "info" ? 1 : -1));
    page.append(section("Changes", { count: ch.length }), h("table", { class: "ptable change-table" }, h("thead", null, h("tr", null, h("th", null, h("span", { class: "sr-only" }, "Kind")), h("th", null, "Change"), h("th", null, "Where"), h("th", null, "Old → new"), h("th", null, "Impact"))), h("tbody", null, sorted.map(changeRow))));
  }
  const labels: [string, string] = [cmp.oldTitle, cmp.newTitle];
  const o = c.old ? c.old.id : undefined;
  const n = c.new ? c.new.id : undefined;
  const lines = (f: (m: Model, id: Id) => Line[], m: Model, id: Id | undefined) => (id === undefined ? [] : f(m, id));
  for (const [title, f] of [["Content model", contentLines], ["Attributes", attrLines], ["Base and facets", facetLines], ["Enumeration", enumLines]] as const) {
    const el = sideBySide(title, lines(f, cmp.old, o), lines(f, cmp.cur, n), labels);
    if (el) page.appendChild(el);
  }
  const da = o !== undefined ? docsText(cmp.old.comp(o).docs) : "";
  const db = n !== undefined ? docsText(cmp.cur.comp(n).docs) : "";
  const docChanges = ch.filter((x) => x.kind === "docsChanged" && (x.path || x.subject));
  if (da || db || docChanges.length) {
    const differs = da.replace(/\s+/g, " ").trim() !== db.replace(/\s+/g, " ").trim();
    const doc = (text: string, st: Mark | undefined, head: string) => h("div", { class: `side${st ? ` d-${st}` : ""}` }, h("div", { class: "side-head" }, st ? mark(st) : null, " ", head), text ? h("p", { class: "doc-text" }, text) : h("p", { class: "faint" }, "(none)"));
    page.append(section("Documentation"), h("div", { class: "sbs" }, doc(da, differs ? "removed" : undefined, labels[0]), doc(db, differs ? "added" : undefined, labels[1])));
    for (const x of docChanges) {
      page.append(h("h3", { class: "doc-sub mono" }, [x.path, x.subject].filter(Boolean).join(" › ")), h("div", { class: "sbs" }, doc(x.old ?? "", "removed", labels[0]), doc(x.new ?? "", "added", labels[1])));
    }
  }
  return page;
}

function diffTarget(ctx: AppCtx, cmp: Compare, c: ComponentDiff): Child {
  const other = cmp.d.components.find((x) => x.kind === c.kind && x !== c && qnameOf(x) === c.possiblyRenamed);
  return other ? diffLink(ctx, other) : h("code", null, c.possiblyRenamed ?? "");
}

/** The banner on a normal component page while comparing. */
export function diffBanner(ctx: AppCtx, cmp: Compare, id: Id): HTMLElement | null {
  const c = cmp.byNew.get(id);
  if (!c) return cmp.d.components.length && ctx.m.comp(id).parent === undefined && !ctx.m.comp(id).builtin ? h("div", { class: "diff-banner" }, h("span", { class: "faint" }, `Unchanged since ${cmp.oldTitle}.`)) : null;
  const n = c.changes?.length ?? 0;
  return h("div", { class: `diff-banner d-${c.status}` }, mark(c.status), " ", c.status === "added" ? `New in ${cmp.newTitle}.` : `${plural(n, "change")} since ${cmp.oldTitle}${c.impact === "breaking" ? ", some breaking" : ""}.`, " ", diffLink(ctx, c, "Compare the versions"), h("span", { class: "faint small legend-diff" }, mark("added"), " added ", mark("removed"), " removed ", mark("changed"), " changed"));
}
