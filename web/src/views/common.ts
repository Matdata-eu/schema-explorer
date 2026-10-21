// Shared building blocks of the detail pages.
import type { AppCtx } from "../ctx";
import { button, copyText, h, type Child } from "../dom";
import { jsonSource } from "../loader";
import { KIND_LABEL, docsText, isId, jsonLabel, type Doc, type Id, type JsonInfo, type Ref } from "../model";
import { highlight, highlightJson, snippet } from "../source";

export function kindBadge(ctx: AppCtx, id: Id): HTMLElement {
  const c = ctx.m.comp(id);
  const json = jsonLabel(c);
  if (json) return h("span", { class: `badge k-${c.kind}` }, json);
  return h("span", { class: `badge k-${c.kind}` }, `${c.parent !== undefined && c.kind !== "complexType" && c.kind !== "simpleType" ? "Local " + KIND_LABEL[c.kind].toLowerCase() : c.parent !== undefined ? "Anonymous " + KIND_LABEL[c.kind].toLowerCase() : KIND_LABEL[c.kind]}`);
}

function tip(ctx: AppCtx, id: Id): string {
  const d = ctx.m.docText(id);
  return `${ctx.m.qname(id) || ctx.m.label(id)} (${KIND_LABEL[ctx.m.comp(id).kind].toLowerCase()})${d ? "\n" + (d.length > 300 ? d.slice(0, 300) + "…" : d) : ""}`;
}

/** A clickable chip for a component. */
export function chip(ctx: AppCtx, id: Id, opts: { text?: string; sub?: string } = {}): HTMLElement {
  const c = ctx.m.comp(id);
  return h(
    "a",
    { class: `chip${c.builtin ? " external" : ""}`, href: ctx.href(id), title: tip(ctx, id), onClick: nav(ctx, id) },
    h("span", { class: `kind-dot k-${c.kind}` }),
    h("span", { class: "lbl" }, opts.text ?? ctx.m.label(id)),
    opts.sub ? h("span", { class: "faint" }, opts.sub) : null
  );
}

/** A plain text link for a component, for use inside sentences and tables. */
export function link(ctx: AppCtx, id: Id, text?: string): HTMLElement {
  return h("a", { href: ctx.href(id), title: tip(ctx, id), onClick: nav(ctx, id) }, text ?? ctx.m.label(id));
}

/** A link to a referenced component, or its name when it was not found. */
export function refLink(ctx: AppCtx, r: Ref | undefined, short = false): Child {
  if (r === undefined) return h("span", { class: "faint" }, "—");
  if (isId(r)) {
    const c = ctx.m.comp(r);
    if (c.builtin) return h("span", { class: "mono builtin", title: "built-in XML Schema type" }, ctx.m.qname(r));
    return h("a", { class: "mono", href: ctx.href(r), title: tip(ctx, r), onClick: nav(ctx, r) }, short || !c.name ? ctx.m.label(r) : ctx.m.qname(r));
  }
  return h("span", { class: "mono missing", title: `not found: ${r}` }, ctx.m.refName(r));
}

export function nav(ctx: AppCtx, id: Id): EventListener {
  return ((ev: MouseEvent) => {
    if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button === 1) return;
    ev.preventDefault();
    ctx.go(id);
  }) as EventListener;
}

export function chips(ctx: AppCtx, ids: Id[], opts: { max?: number } = {}): HTMLElement {
  const max = opts.max ?? 40;
  const wrap = h("div", { class: "chips" });
  const render = (limit: number) => {
    wrap.replaceChildren();
    for (const id of ids.slice(0, limit)) wrap.appendChild(chip(ctx, id));
    if (ids.length > limit) wrap.appendChild(h("button", { class: "chip more", type: "button", onClick: () => render(ids.length) }, `+${ids.length - limit} more`));
  };
  render(max);
  return wrap;
}

export function section(title: string, opts: { count?: number; tools?: Child[]; id?: string } = {}): HTMLElement {
  return h("div", { class: "section-title", id: opts.id }, h("span", null, title), opts.count !== undefined ? h("span", { class: "count" }, opts.count.toLocaleString()) : null, opts.tools?.length ? h("div", { class: "tools" }, ...opts.tools) : null);
}

/** Name, badges, namespace and source location of a component. */
export function pageHead(ctx: AppCtx, id: Id, badges: Child[] = []): HTMLElement {
  const m = ctx.m;
  const c = m.comp(id);
  const crumbs: Child[] = [];
  if (c.parent !== undefined) {
    const chain: Id[] = [];
    let cur: Id | undefined = c.parent;
    while (cur !== undefined && chain.length < 12) {
      chain.unshift(cur);
      cur = m.comp(cur).parent;
    }
    crumbs.push(h("div", { class: "crumbs" }, chain.map((p, i) => [i ? h("span", { class: "sep" }, "›") : null, link(ctx, p, m.label(p))]), h("span", { class: "sep" }, "›"), h("span", null, m.label(id))));
  }
  const ns = c.ns !== undefined ? m.b.namespaces[c.ns] : undefined;
  const file = m.fileName(id);
  const qn = m.qname(id);
  return h(
    "div",
    null,
    ...crumbs,
    h("div", { class: "page-head" }, h("h1", { class: c.complexType?.abstract || c.element?.abstract ? "abstract" : "" }, m.label(id)), kindBadge(ctx, id), ...jsonBadges(c.json), ...badges),
    h(
      "div",
      { class: "iri-line" },
      qn ? h("span", { class: "mono", title: ns ? `{${ns.uri}}${c.name}` : "no namespace" }, qn) : null,
      qn ? button("", () => copyText(qn).then((ok) => ctx.toast(ok ? "Name copied" : "Could not copy")), { icon: "copy", cls: "ghost icon-only", title: "Copy the qualified name" }) : null,
      ns ? h("span", { class: "faint mono small" }, ns.uri) : h("span", { class: "faint small" }, c.builtin ? "built in" : "no namespace"),
      file !== undefined ? h("a", { class: "badge src", href: ctx.hrefRoute({ view: "file", id: c.file }), onClick: (ev: Event) => {
        ev.preventDefault();
        ctx.goRoute({ view: "file", id: c.file });
      }, title: "The file it is declared in" }, `${file}${c.line ? ":" + c.line : ""}`) : null
    ),
    docBlock(c.docs)
  );
}

/** Documentation, with "read more" for long texts. */
export function docBlock(docs: Doc[] | undefined, cls = "lead"): HTMLElement | null {
  const text = docsText(docs);
  if (!text) return null;
  const p = h("p", { class: `${cls} pre-line${text.length > 600 ? " clamp" : ""}` }, text);
  if (text.length <= 600) return p;
  const more = h("button", { class: "linkish small", type: "button", onClick: () => {
    p.classList.toggle("clamp");
    more.textContent = p.classList.contains("clamp") ? "Read more" : "Show less";
  } }, "Read more");
  return h("div", null, p, more);
}

/** A short one-line documentation for table cells. */
export function shortDoc(docs: Doc[] | undefined, max = 220): HTMLElement | null {
  const t = docsText(docs);
  if (!t) return null;
  return h("div", { class: "desc", title: t.length > max ? t : undefined }, t.length > max ? t.slice(0, max) + "…" : t);
}

export function emptyNote(text: string): HTMLElement {
  return h("p", { class: "muted" }, text);
}

/** "Where used": the global components that refer to this one, with how. */
export function whereUsed(ctx: AppCtx, id: Id): HTMLElement | null {
  const m = ctx.m;
  const uses = m.usedBy(id);
  if (!uses.length) return null;
  const HOW: Record<string, string> = { type: "as type", base: "as base", item: "as list item", member: "in union", element: "by reference", attribute: "by reference", group: "by reference", attributeGroup: "by reference", substitution: "substitutes", refer: "referred by" };
  const byOwner = new Map<Id, { by: Id; how: string }[]>();
  for (const u of uses) {
    const l = byOwner.get(u.owner) ?? [];
    l.push(u);
    byOwner.set(u.owner, l);
  }
  const owners = [...byOwner.keys()].sort((a, b) => m.label(a).localeCompare(m.label(b)));
  const table = h("table", { class: "ptable compact" }, h("thead", null, h("tr", null, h("th", null, "In"), h("th", null, "Where"), h("th", null, "How"))));
  const tbody = h("tbody");
  const render = (limit: number) => {
    tbody.replaceChildren();
    for (const o of owners.slice(0, limit)) {
      for (const u of byOwner.get(o)!) {
        const where = u.by === o ? h("span", { class: "faint" }, "itself") : localPath(ctx, u.by, o);
        tbody.appendChild(h("tr", null, h("td", null, chip(ctx, o)), h("td", null, where), h("td", { class: "faint" }, HOW[u.how] ?? u.how)));
      }
    }
    if (owners.length > limit) tbody.appendChild(h("tr", null, h("td", { colspan: 3 }, h("button", { class: "linkish", type: "button", onClick: () => render(owners.length) }, `Show all ${owners.length}`))));
  };
  render(60);
  table.appendChild(tbody);
  return h("div", null, section("Where used", { count: owners.length }), table);
}

/** The path of a local declaration inside its global component: a / b / c. */
export function localPath(ctx: AppCtx, id: Id, owner: Id): HTMLElement {
  const parts: Id[] = [];
  let cur: Id | undefined = id;
  while (cur !== undefined && cur !== owner && parts.length < 10) {
    const c = ctx.m.comp(cur);
    if (c.name) parts.unshift(cur);
    cur = c.parent;
  }
  return h("span", { class: "mono small" }, parts.map((p, i) => [i ? " / " : "", link(ctx, p, (ctx.m.comp(p).kind === "attribute" ? "@" : "") + (ctx.m.comp(p).name ?? ""))]));
}

/** The component's XSD, cut from its file, loaded when opened. */
export function sourceSection(ctx: AppCtx, id: Id): HTMLElement | null {
  const c = ctx.m.comp(id);
  if (c.json) return jsonSourceSection(ctx, id);
  if (c.file === undefined || !c.line) return null;
  const file = c.file;
  const body = h("div", { class: "xsd-body" }, h("p", { class: "faint small" }, "Loading…"));
  const det = h("details", { class: "xsd-src", open: ctx.route.params.src === "1" || undefined }, h("summary", null, h("span", null, "XSD source"), h("span", { class: "faint small" }, ` ${ctx.m.b.files[file].name}:${c.line}`)), body);
  let loaded = false;
  const load = async () => {
    if (loaded) return;
    loaded = true;
    const text = await ctx.sourceText(file);
    if (text === null) {
      body.replaceChildren(h("p", { class: "muted small" }, "The schema file is not available here: the bundle was loaded without its .xsd files."));
      return;
    }
    const sn = snippet(text, c.line!);
    if (!sn) {
      body.replaceChildren(h("p", { class: "muted small" }, "Could not find the declaration in the file."));
      return;
    }
    const copy = button("Copy", () => copyText(sn.text).then((ok) => ctx.toast(ok ? "XSD copied" : "Could not copy")), { icon: "copy", cls: "small" });
    body.replaceChildren(h("div", { class: "xsd-tools" }, h("span", { class: "faint small" }, `lines ${sn.startLine}–${sn.startLine + sn.text.split("\n").length - 1}`), copy), highlight(ctx.m, file, sn.text, (target, text) => link(ctx, target, text)));
  };
  det.addEventListener("toggle", () => {
    ctx.setParams({ src: det.open ? "1" : undefined });
    if (det.open) void load();
  });
  if (det.open) void load();
  return det;
}

function jsonBadges(j: JsonInfo | undefined): Child[] {
  if (!j) return [];
  return [j.deprecated ? h("span", { class: "badge", title: "deprecated: true" }, "deprecated") : null, j.readOnly ? h("span", { class: "badge" }, "read-only") : null, j.writeOnly ? h("span", { class: "badge" }, "write-only") : null, j.title ? h("span", { class: "muted small" }, j.title) : null];
}

/** The component's schema as JSON (also for YAML files), loaded when opened. */
function jsonSourceSection(ctx: AppCtx, id: Id): HTMLElement | null {
  const c = ctx.m.comp(id);
  if (c.file === undefined || !c.json) return null;
  const file = c.file;
  const name = ctx.m.b.files[file].name;
  const pointer = c.json.pointer ?? "";
  const body = h("div", { class: "xsd-body" }, h("p", { class: "faint small" }, "Loading…"));
  const det = h("details", { class: "xsd-src", open: ctx.route.params.src === "1" || undefined }, h("summary", null, h("span", null, "JSON source"), h("span", { class: "faint small" }, ` ${name}#${pointer}`)), body);
  let loaded = false;
  const load = async () => {
    if (loaded) return;
    loaded = true;
    const text = await ctx.sourceText(file);
    if (text === null) {
      body.replaceChildren(h("p", { class: "muted small" }, "The schema file is not available here: the bundle was loaded without its schema files."));
      return;
    }
    let json: string;
    try {
      json = await jsonSource(name, text, pointer);
    } catch {
      body.replaceChildren(h("p", { class: "muted small" }, "Could not find the schema in the file."));
      return;
    }
    const yaml = /\.ya?ml$/i.test(name);
    const copy = button("Copy", () => copyText(json).then((ok) => ctx.toast(ok ? "JSON copied" : "Could not copy")), { icon: "copy", cls: "small" });
    body.replaceChildren(h("div", { class: "xsd-tools" }, h("span", { class: "faint small" }, yaml ? "shown as JSON" : `${json.split("\n").length} lines`), copy), highlightJson(ctx.m, file, json, (target, text) => link(ctx, target, text)));
  };
  det.addEventListener("toggle", () => {
    ctx.setParams({ src: det.open ? "1" : undefined });
    if (det.open) void load();
  });
  if (det.open) void load();
  const examples = c.json.examples ?? [];
  if (!examples.length) return det;
  return h("div", null, h("details", { class: "xsd-src" }, h("summary", null, h("span", null, examples.length === 1 ? "Example" : `Examples (${examples.length})`)), h("div", { class: "xsd-body" }, examples.map((e) => highlightJson(ctx.m, file, pretty(e), (target, text) => link(ctx, target, text))))), det);
}

function pretty(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}

/** Facets as a definition list. */
export function facetList(facets: { kind: string; value: string; fixed?: boolean }[]): HTMLElement {
  const dl = h("dl", { class: "kv" });
  for (const f of facets) dl.append(h("dt", null, f.kind), h("dd", null, h("code", null, f.value), f.fixed ? h("span", { class: "faint" }, " (fixed)") : null));
  return dl;
}
