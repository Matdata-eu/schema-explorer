// Compare mode, both versions next to each other: each version's own class
// diagram (laid out together so matching boxes sit at the same place), its
// content tree lined up row by row, and its XSD source with a line diff.
import type { AppCtx, Route } from "../ctx";
import { Diagram, layoutGraph, type View } from "../diagram";
import { MARKER, type Compare, type ComponentDiff, type Mark } from "../diff";
import { button, h, icon, plural, type Child } from "../dom";
import { buildNeighborhood, defaultNeighborhood, toMermaid, toPlantUml, type GraphSpec, type NeighborhoodOptions } from "../graph";
import { KIND_SLUG, type Id, type Model } from "../model";
import { highlight, snippet } from "../source";
import { diffSeq, intraLine, pairRows, type Row } from "../textdiff";
import { TreeView, pairTrees, rootNode, setTreeDiff, type TNode } from "../tree";
import { boxActions, exportControls, fullscreenButton, refitOnResize, whenVisible } from "./diagramPanel";
import { link } from "./common";

export type Which = "old" | "new";

/**
 * The context of one version: its model, links to its own pages and its own
 * schema files. `here` keeps links to the component itself on the compare page.
 */
export function versionCtx(ctx: AppCtx, cmp: Compare, which: Which, here?: { id: Id; route: Route }): AppCtx {
  const m = which === "old" ? cmp.old : cmp.cur;
  const target = (id: Id, extra: Partial<Route> = {}): Partial<Route> => {
    if (here && id === here.id) return { ...here.route, tab: extra.tab ?? here.route.tab, params: { v: here.route.params.v ?? which, ...(extra.params ?? {}) } };
    return { view: which === "old" ? "old" : "comp", id, tab: extra.tab, params: extra.params ?? {} };
  };
  return {
    get m() {
      return m;
    },
    get route() {
      return ctx.route;
    },
    get prefs() {
      return ctx.prefs;
    },
    get embed() {
      return ctx.embed;
    },
    cmp: null,
    go: (id, extra) => ctx.goRoute(target(id, extra)),
    goRoute: (r) => ctx.goRoute(r),
    href: (id, extra) => ctx.hrefRoute(target(id, extra)),
    hrefRoute: (r) => ctx.hrefRoute(r),
    setPrefs: (p) => ctx.setPrefs(p),
    toast: (msg) => ctx.toast(msg),
    setParams: (p) => ctx.setParams(p),
    shareLink: () => ctx.shareLink(),
    refresh: () => ctx.refresh(),
    sourceText: (file) => (which === "old" ? cmp.oldSourceText(file) : ctx.sourceText(file)),
  };
}

/** The complex type a component's class diagram is centred on. */
export function diagramFocus(m: Model, id: Id | undefined): Id | undefined {
  if (id === undefined) return undefined;
  const c = m.comp(id);
  if (c.kind === "complexType") return id;
  if (c.kind === "element") {
    const t = m.elementType(id);
    return m.isComplex(t) ? t : undefined;
  }
  return undefined;
}

/** The component a content tree starts from. */
export function treeFocus(m: Model, id: Id | undefined): Id | undefined {
  if (id === undefined) return undefined;
  const c = m.comp(id);
  if (c.kind === "complexType" || c.kind === "group") return id;
  if (c.kind === "element" && m.isComplex(m.elementType(id))) return id;
  return undefined;
}

// ---- class diagrams ----------------------------------------------------------

/** Name the boxes and lines by qualified name, so both versions' graphs share keys. */
function keyed(g: GraphSpec, m: Model): GraphSpec {
  const map = new Map<string, string>();
  for (const n of g.nodes) map.set(n.key, n.id !== undefined ? `${n.key[0]}:${m.qname(n.id) || m.label(n.id)}` : n.key);
  const k = (key: string) => map.get(key) ?? key;
  const seen = new Map<string, number>();
  return {
    omitted: g.omitted,
    nodes: g.nodes.map((n) => ({ ...n, key: k(n.key), attrs: n.attrs.map((a) => ({ ...a })) })),
    edges: g.edges.map((e) => {
      const base = `${e.kind}|${k(e.from)}|${k(e.to)}|${e.label ?? ""}`;
      const i = (seen.get(base) ?? 0) + 1;
      seen.set(base, i);
      return { ...e, key: i > 1 ? `${base}#${i}` : base, from: k(e.from), to: k(e.to) };
    }),
  };
}

const prefix = (d: Mark | undefined, t: string) => (d ? `${MARKER[d]} ${t}` : t);

/** Mark what differs between the two versions' graphs (on both), and the graph of both together for the layout. */
function markGraphs(a: GraphSpec, b: GraphSpec, cmp: Compare): GraphSpec {
  const na = new Map(a.nodes.map((n) => [n.key, n]));
  const nb = new Map(b.nodes.map((n) => [n.key, n]));
  const lineKey = (t: string) => t;
  const sig = (x: { type?: string; mult?: string }) => `${x.type ?? ""}|${x.mult ?? ""}`;
  const changedComp = (m: "old" | "new", id: Id | undefined) => {
    if (id === undefined) return false;
    const cd = m === "old" ? cmp.byOld.get(id) : cmp.byNew.get(id);
    return cd?.status === "changed" && cd.impact !== "info";
  };
  for (const n of a.nodes) {
    const o = nb.get(n.key);
    if (!o) {
      n.diff = "removed";
      n.name = prefix("removed", n.name);
      continue;
    }
    const la = new Map(n.attrs.map((x) => [lineKey(x.text), x]));
    const lb = new Map(o.attrs.map((x) => [lineKey(x.text), x]));
    let differs = changedComp("old", n.id) || changedComp("new", o.id);
    for (const x of n.attrs) {
      const y = lb.get(lineKey(x.text));
      const d: Mark | undefined = !y ? "removed" : sig(x) !== sig(y) ? "changed" : undefined;
      if (d) {
        differs = true;
        x.diff = d;
      }
    }
    for (const y of o.attrs) {
      const x = la.get(lineKey(y.text));
      const d: Mark | undefined = !x ? "added" : sig(x) !== sig(y) ? "changed" : undefined;
      if (d) {
        differs = true;
        y.diff = d;
      }
    }
    for (const x of n.attrs) if (x.diff) x.text = prefix(x.diff, x.text);
    for (const y of o.attrs) if (y.diff) y.text = prefix(y.diff, y.text);
    if (differs) {
      n.diff = o.diff = "changed";
      n.name = prefix("changed", n.name);
      o.name = prefix("changed", o.name);
    }
  }
  for (const n of b.nodes)
    if (!na.has(n.key)) {
      n.diff = "added";
      n.name = prefix("added", n.name);
    }
  const ea = new Map(a.edges.map((e) => [e.key, e]));
  const eb = new Map(b.edges.map((e) => [e.key, e]));
  for (const e of a.edges) {
    const o = eb.get(e.key);
    const d: Mark | undefined = !o ? "removed" : (o.mult ?? "") !== (e.mult ?? "") ? "changed" : undefined;
    if (d) e.diff = d;
    if (o && d) o.diff = d;
  }
  for (const e of b.edges) if (!ea.has(e.key)) e.diff = "added";
  // A line drawn from the using side (no multiplicity on it): the diff knows whether the child changed.
  for (const e of b.edges) {
    const from = nb.get(e.from)?.id;
    if (e.diff || e.kind !== "comp" || e.id === undefined || from === undefined) continue;
    if (cmp.childMarks(from).children.get(cmp.cur.comp(e.id).name ?? "") !== "changed") continue;
    e.diff = "changed";
    const o = ea.get(e.key);
    if (o) o.diff = "changed";
  }
  for (const e of [...a.edges, ...b.edges]) if (e.diff && e.label) e.label = prefix(e.diff, e.label);
  // Both together: a box gets the lines of both versions, so it has room for either.
  const nodes = b.nodes.map((n) => {
    const o = na.get(n.key);
    if (!o) return n;
    const have = new Set(n.attrs.map((x) => x.text));
    return { ...n, attrs: [...n.attrs, ...o.attrs.filter((x) => !have.has(x.text))], hiddenAttrs: Math.max(n.hiddenAttrs, o.hiddenAttrs) };
  });
  for (const n of a.nodes) if (!nb.has(n.key)) nodes.push(n);
  const edges = [...b.edges, ...a.edges.filter((e) => !eb.has(e.key))];
  return { nodes, edges, omitted: Math.max(a.omitted, b.omitted) };
}

const empty: GraphSpec = { nodes: [], edges: [], omitted: 0 };

interface Pane {
  wrap: HTMLElement;
  which: Which;
  title: string;
  note: HTMLElement;
}

function pane(cls: string, which: Which, title: string, missing: boolean): Pane {
  const note = h("div", { class: "sbs-missing", hidden: !missing }, `Not in ${title}`);
  const wrap = h("div", { class: `diagram sbs-pane ${cls} side-${which}` }, note);
  return { wrap, which, title, note };
}

const paneHead = (which: Which, title: string) => h("span", { class: `sbs-label side-${which}` }, which === "old" ? "Old" : "New", h("span", { class: "faint" }, ` · ${title}`));

/** The link toggle shared by both side-by-side panels. */
function syncButton(ctx: AppCtx, get: () => boolean, set: (v: boolean) => void): HTMLButtonElement {
  const b = button("Linked", () => {
    set(!get());
    b.setAttribute("aria-pressed", String(get()));
    ctx.setParams({ sync: get() ? undefined : "0" });
  }, { cls: "small", icon: "link", pressed: get(), title: "Pan and zoom both sides together" });
  return b;
}

const zoomBoth = (ds: Diagram[], sync: () => boolean) =>
  h(
    "div",
    { class: "btn-group" },
    button("", () => ds.forEach((d, i) => (i === 0 || !sync() ? d.zoomBy(1.25) : null)), { cls: "small icon-only", icon: "plus", title: "Zoom in" }),
    button("", () => ds.forEach((d, i) => (i === 0 || !sync() ? d.zoomBy(0.8) : null)), { cls: "small icon-only", icon: "minus", title: "Zoom out" }),
    button("", () => ds.forEach((d) => d.fit()), { cls: "small icon-only", icon: "fit", title: "Fit" })
  );

/** Move the other diagram along with a pan or zoom, while linked. */
function link2(a: Diagram, b: Diagram, sync: () => boolean): { onA: (v: View) => void; onB: (v: View) => void } {
  return { onA: (v) => sync() && b.setView(v), onB: (v) => sync() && a.setView(v) };
}

/** The old and the new class diagram next to each other, laid out together. */
export function sbsDiagramPanel(ctx: AppCtx, cmp: Compare, oldFocus: Id | undefined, newFocus: Id | undefined): HTMLElement {
  const P = ctx.route.params;
  const p = ctx.prefs;
  const flag = (k: string, def: boolean) => (P[k] === undefined ? def : P[k] === "1");
  const focusAny = (newFocus ?? oldFocus)!;
  const base = defaultNeighborhood(focusAny);
  const o = {
    depth: (P.depth === "2" ? 2 : P.depth === "1" ? 1 : p.depth) as 1 | 2,
    inherited: flag("inh", false),
    incoming: flag("inc", p.incoming),
    derived: flag("sub", base.derived),
    enums: flag("enum", p.enums),
  };
  // Opened boxes are kept by qualified name, so they open on both sides.
  const expanded = new Set((P.xq ?? "").split(" ").filter(Boolean));
  const openAttrs = new Set((P.openq ?? "").split(" ").filter(Boolean));
  let direction: "DOWN" | "RIGHT" = P.dir === "right" ? "RIGHT" : P.dir === "down" ? "DOWN" : p.direction;
  let sync = P.sync !== "0";
  const bit = (v: boolean) => (v ? "1" : "0");
  const save = () => ctx.setParams({ depth: String(o.depth), dir: direction.toLowerCase(), inh: bit(o.inherited), inc: bit(o.incoming), sub: bit(o.derived), enum: bit(o.enums), xq: [...expanded].join(" ") || undefined, openq: [...openAttrs].join(" ") || undefined });
  const ids = (m: Model, names: Set<string>) => new Set([...names].map((q) => m.find("ct", q)).filter((x): x is Id => x !== undefined));
  const optsFor = (m: Model, focus: Id): NeighborhoodOptions => ({ ...defaultNeighborhood(focus), ...o, expanded: ids(m, expanded), openAttrs: ids(m, openAttrs) });

  const left = pane("", "old", cmp.oldTitle, oldFocus === undefined);
  const right = pane("", "new", cmp.newTitle, newFocus === undefined);
  const statusOf = (pn: Pane) => {
    const t = h("span");
    pn.wrap.append(h("div", { class: "status" }, t));
    return t;
  };
  const sides = [left, right].map((pn) => {
    const which = pn.which;
    const m = which === "old" ? cmp.old : cmp.cur;
    const focus = which === "old" ? oldFocus : newFocus;
    const vctx = versionCtx(ctx, cmp, which);
    const status = statusOf(pn);
    const toggleSet = (set: Set<string>, id: Id) => {
      const q = m.qname(id);
      if (!q) return;
      if (set.has(q)) set.delete(q);
      else set.add(q);
      run(true);
    };
    const d = new Diagram(pn.wrap, {
      onNavigate: (id) => vctx.go(id),
      onExpand: (id) => (m.comp(id).kind === "complexType" ? toggleSet(expanded, id) : vctx.go(id)),
      nodeMenu: (id) => boxActions(vctx, id, id === focus || m.comp(id).kind !== "complexType" || !m.qname(id) ? undefined : { expanded: expanded.has(m.qname(id)), toggle: () => toggleSet(expanded, id) }),
      onToggleAttrs: (id) => toggleSet(openAttrs, id),
      onStatus: (t) => (status.textContent = t),
      onTransform: (v) => (which === "old" ? links.onA(v) : links.onB(v)),
    });
    let graph: GraphSpec | null = null;
    const { exportBtn, exportMenu } = exportControls(vctx, d, `${focus !== undefined ? m.label(focus) : "diagram"}-${pn.title}`, () => (graph ? { plantuml: toPlantUml(graph), mermaid: toMermaid(graph) } : null), pn.wrap);
    pn.wrap.prepend(h("div", { class: "dtools" }, paneHead(which, pn.title), h("span", { class: "spacer" }), exportBtn), exportMenu);
    refitOnResize(pn.wrap, d);
    return { d, m, focus, setGraph: (g: GraphSpec) => (graph = g) };
  });
  const links = link2(sides[0].d, sides[1].d, () => sync);
  const overlay = h("div", { class: "overlay" }, "Laying out…");
  const wrap = h("div", { class: "sbs-panel" });
  let started = false;
  const run = (keepView = false) => {
    if (!started) return;
    wrap.appendChild(overlay);
    save();
    const [a, b] = sides.map((s) => (s.focus !== undefined ? keyed(buildNeighborhood(s.m, optsFor(s.m, s.focus)), s.m) : { ...empty }));
    const both = markGraphs(a, b, cmp);
    const shared = layoutGraph(both, { direction });
    sides[0].setGraph(a);
    sides[1].setGraph(b);
    void Promise.all([sides[0].d.render(a, { direction, keepView, shared }), sides[1].d.render(b, { direction, keepView, shared })]).finally(() => {
      overlay.remove();
      if (sync && keepView) sides[1].d.setView(sides[0].d.view);
    });
  };
  const toggle = (label: string, get: () => boolean, set: (v: boolean) => void, title: string) => {
    const b = button(label, () => {
      set(!get());
      b.setAttribute("aria-pressed", String(get()));
      run(true);
    }, { cls: "small", pressed: get(), title });
    return b;
  };
  const depthBtn = button(`Depth ${o.depth}`, () => {
    o.depth = o.depth === 1 ? 2 : 1;
    depthBtn.querySelector("span")!.textContent = `Depth ${o.depth}`;
    run(false);
  }, { cls: "small", title: "How many steps away from this type to show" });
  const dirBtn = button("", () => {
    direction = direction === "DOWN" ? "RIGHT" : "DOWN";
    run(false);
  }, { cls: "small icon-only", icon: "tree", title: "Flip the layout direction" });
  const tools = h(
    "div",
    { class: "sbs-tools" },
    depthBtn,
    toggle("Inherited", () => o.inherited, (v) => (o.inherited = v), "List inherited attributes and child elements in this type's box"),
    toggle("Used by", () => o.incoming, (v) => (o.incoming = v), "Show the types and elements that use this type"),
    toggle("Derived", () => o.derived, (v) => (o.derived = v), "Show the types derived from this one"),
    toggle("Enumerations", () => o.enums, (v) => (o.enums = v), "Show enumerated simple types as boxes"),
    dirBtn,
    h("span", { class: "spacer" }),
    syncButton(ctx, () => sync, (v) => {
      sync = v;
      if (v) sides[1].d.setView(sides[0].d.view);
    }),
    zoomBoth(sides.map((s) => s.d), () => sync),
    fullscreenButton(wrap)
  );
  wrap.append(tools, h("div", { class: "sbs-grid" }, left.wrap, right.wrap), legend());
  whenVisible(wrap, () => {
    started = true;
    run(false);
  });
  return wrap;
}

function legend(): HTMLElement {
  const item = (m: Mark, text: string) => h("span", { class: `sbs-key d-${m}` }, h("span", { class: `dmark d-${m}` }, MARKER[m]), " ", text);
  return h("p", { class: "faint hint sbs-legend" }, item("removed", "only in the old version (left)"), item("added", "only in the new version (right)"), item("changed", "in both, but different"), h("span", null, "Double-click a box to add its neighbours on both sides."));
}

// ---- content trees -----------------------------------------------------------

/** The old and the new content tree next to each other, lined up row by row. */
export function sbsTreePanel(ctx: AppCtx, cmp: Compare, oldFocus: Id | undefined, newFocus: Id | undefined): HTMLElement {
  const P = ctx.route.params;
  const open = new Set((P.tree ?? "").split(" ").filter(Boolean));
  let sync = P.sync !== "0";
  setTreeDiff(null);
  const ra = oldFocus !== undefined ? rootNode(cmp.old, oldFocus) : undefined;
  const rb = newFocus !== undefined ? rootNode(cmp.cur, newFocus) : undefined;
  const [la, lb] = ra || rb ? pairTrees(ra, rb) : [undefined, undefined];
  const left = pane("tall", "old", cmp.oldTitle, oldFocus === undefined);
  const right = pane("tall", "new", cmp.newTitle, newFocus === undefined);
  const isCompositor = (n: TNode) => n.kind === "sequence" || n.kind === "choice" || n.kind === "all" || n.kind === "type";
  const toggleNode = (n: TNode, isOpen: boolean) => {
    if (isCompositor(n)) {
      if (isOpen) open.delete("-" + n.key);
      else open.add("-" + n.key);
    } else if (isOpen) open.add(n.key);
    else open.delete(n.key);
    run(true);
  };
  const expandBelow = (n: TNode, levels: number) => {
    if (levels <= 0 || !n.expandable) return;
    if (n.kind === "element" || n.kind === "group") open.add(n.key);
    for (const c of n.children()) expandBelow(c, c.kind === "element" ? levels - 1 : levels);
  };
  const views = [left, right].map((pn) => {
    const which = pn.which;
    const m = which === "old" ? cmp.old : cmp.cur;
    const vctx = versionCtx(ctx, cmp, which);
    const status = h("span");
    pn.wrap.append(h("div", { class: "status" }, status));
    const t: TreeView = new TreeView(pn.wrap, {
      onToggle: toggleNode,
      actions: (n: TNode) => {
        const a: { label: string; icon?: string; run: () => void }[] = [];
        if (n.expandable && n.kind !== "type") {
          const isOpen = isCompositor(n) ? !open.has("-" + n.key) : open.has(n.key);
          a.push({ label: isOpen ? "Collapse (both sides)" : "Expand (both sides)", icon: isOpen ? "minus" : "plus", run: () => toggleNode(n, !isOpen) });
        }
        if (n.id !== undefined) a.push({ label: n.kind === "group" ? "Open the group" : n.kind === "type" ? "Open the type" : "Open the element", icon: "external", run: () => vctx.go(n.id!) });
        if (n.typeId !== undefined && n.typeId !== n.id && !m.comp(n.typeId).builtin) a.push({ label: `Open the type ${m.label(n.typeId)}`, icon: "external", run: () => vctx.go(n.typeId!) });
        return a;
      },
      onStatus: (s) => (status.textContent = s),
      onTransform: (v) => (which === "old" ? links.onA(v) : links.onB(v)),
    });
    const { exportBtn, exportMenu } = exportControls(vctx, t, `tree-${pn.title}`, null, pn.wrap);
    pn.wrap.prepend(h("div", { class: "dtools" }, paneHead(which, pn.title), h("span", { class: "spacer" }), exportBtn), exportMenu);
    refitOnResize(pn.wrap, t);
    return t;
  });
  const links = link2(views[0], views[1], () => sync);
  const wrap = h("div", { class: "sbs-panel" });
  let started = false;
  const run = (keepView = false) => {
    if (!started) return;
    if (la) views[0].show(la, open, { keepView });
    if (lb) views[1].show(lb, open, { keepView });
    if (sync) views[1].setView(views[0].view);
    ctx.setParams({ tree: [...open].join(" ") || undefined });
  };
  const tools = h(
    "div",
    { class: "sbs-tools" },
    button("Expand 2 levels", () => {
      if (la) expandBelow(la, 2);
      if (lb) expandBelow(lb, 2);
      run(false);
    }, { cls: "small", title: "Open the child elements two levels deep, on both sides" }),
    button("Collapse all", () => {
      open.clear();
      run(false);
    }, { cls: "small" }),
    h("span", { class: "spacer" }),
    syncButton(ctx, () => sync, (v) => {
      sync = v;
      if (v) views[1].setView(views[0].view);
    }),
    zoomBoth(views, () => sync),
    fullscreenButton(wrap)
  );
  const item = (m: Mark, text: string) => h("span", { class: `sbs-key d-${m}` }, h("span", { class: `dmark d-${m}` }, MARKER[m]), " ", text);
  wrap.append(tools, h("div", { class: "sbs-grid" }, left.wrap, right.wrap), h("p", { class: "faint hint sbs-legend" }, item("removed", "only in the old version"), item("added", "only in the new version"), item("changed", "type or multiplicity changed"), h("span", null, "A dotted blank stands for an item the other side has. Opening a node opens it on both sides.")));
  whenVisible(wrap, () => {
    started = true;
    run(false);
  });
  return wrap;
}

// ---- XSD source ----------------------------------------------------------------

/** Cut the highlighted source into one fragment per line (spans broken at line ends are split). */
function splitLines(pre: HTMLElement): HTMLElement[] {
  const lines: HTMLElement[] = [];
  let cur = h("span", { class: "cl" });
  for (const node of [...pre.childNodes]) {
    const text = node.textContent ?? "";
    if (!text.includes("\n")) {
      cur.appendChild(node);
      continue;
    }
    text.split("\n").forEach((part, i) => {
      if (i > 0) {
        lines.push(cur);
        cur = h("span", { class: "cl" });
      }
      if (!part) return;
      if (node.nodeType === Node.TEXT_NODE) cur.append(part);
      else {
        const c = node.cloneNode(false) as HTMLElement;
        c.textContent = part;
        cur.appendChild(c);
      }
    });
  }
  lines.push(cur);
  return lines;
}

/** Wrap the characters [from, to) of a line in a highlight. */
function markRanges(el: HTMLElement, ranges: [number, number][]): void {
  if (!ranges.length) return;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  while (walker.nextNode()) texts.push(walker.currentNode as Text);
  let at = 0;
  for (const t of texts) {
    const s = at;
    const e = at + t.data.length;
    at = e;
    const cuts = ranges.filter(([a, b]) => a < e && b > s);
    if (!cuts.length) continue;
    const frag = document.createDocumentFragment();
    let pos = s;
    for (const [a, b] of cuts) {
      const from = Math.max(a, s);
      const to = Math.min(b, e);
      if (from > pos) frag.append(t.data.slice(pos - s, from - s));
      frag.append(h("span", { class: "ch" }, t.data.slice(from - s, to - s)));
      pos = to;
    }
    if (pos < e) frag.append(t.data.slice(pos - s));
    t.replaceWith(frag);
  }
}

interface SourceSide {
  text: string;
  startLine: number;
  lines: HTMLElement[];
  where: string;
}

async function loadSide(ctx: AppCtx, cmp: Compare, which: Which, id: Id | undefined): Promise<SourceSide | string | null> {
  if (id === undefined) return null;
  const vctx = versionCtx(ctx, cmp, which);
  const m = vctx.m;
  const c = m.comp(id);
  if (c.file === undefined || !c.line) return "No source location is known for it.";
  const text = await vctx.sourceText(c.file);
  if (text === null) return `The .xsd files of ${which === "old" ? cmp.oldTitle : cmp.newTitle} are not available here: the bundle was loaded without them.`;
  const sn = snippet(text, c.line);
  if (!sn) return "Could not find the declaration in the file.";
  const pre = highlight(m, c.file, sn.text, (target, t) => link(vctx, target, t));
  return { text: sn.text, startLine: sn.startLine, lines: splitLines(pre), where: `${m.b.files[c.file].name}:${c.line}` };
}

const MK: Record<string, string> = { del: "−", ins: "+", chg: "~", eq: "" };

/** The XSD of both versions with a line diff: side by side (rows aligned, one scroll) or unified. */
export function sbsSourcePanel(ctx: AppCtx, cmp: Compare, c: ComponentDiff): HTMLElement {
  const P = ctx.route.params;
  let unified = P.code === "unified" || (P.code === undefined && typeof window !== "undefined" && window.innerWidth < 700);
  let changedOnly = P.ctx !== "all";
  const body = h("div", { class: "codediff-body" }, h("p", { class: "faint small" }, "Loading…"));
  const counts = h("span", { class: "faint small" });
  const sbsBtn = button("Side by side", () => setMode(false), { cls: "small", pressed: !unified });
  const uniBtn = button("Unified", () => setMode(true), { cls: "small", pressed: unified });
  const ctxBtn = button("Unchanged lines", () => {
    changedOnly = !changedOnly;
    ctxBtn.setAttribute("aria-pressed", String(!changedOnly));
    ctx.setParams({ ctx: changedOnly ? undefined : "all" });
    draw();
  }, { cls: "small", pressed: !changedOnly, title: "Show every line, not only the changes and a few lines around them" });
  const setMode = (u: boolean) => {
    unified = u;
    sbsBtn.setAttribute("aria-pressed", String(!u));
    uniBtn.setAttribute("aria-pressed", String(u));
    ctx.setParams({ code: u ? "unified" : "split" });
    draw();
  };
  const wrap = h("div", { class: "codediff" }, h("div", { class: "codediff-tools" }, h("div", { class: "btn-group" }, sbsBtn, uniBtn), ctxBtn, counts), body);
  let a: SourceSide | null = null;
  let b: SourceSide | null = null;
  let rows: Row[] = [];
  let ranges = new Map<number, { a: [number, number][]; b: [number, number][] }>();

  const lineA = (i: number) => {
    const el = a!.lines[i].cloneNode(true) as HTMLElement;
    // Clones lose the listeners of the links: put them back by delegating to the original.
    rewire(el, a!.lines[i]);
    return el;
  };
  const lineB = (i: number) => {
    const el = b!.lines[i].cloneNode(true) as HTMLElement;
    rewire(el, b!.lines[i]);
    return el;
  };
  const code = (side: "a" | "b", r: Row, idx: number | undefined): HTMLElement => {
    if (idx === undefined) return h("td", { class: "code blank" });
    const el = side === "a" ? lineA(idx) : lineB(idx);
    const rg = ranges.get(rows.indexOf(r));
    if (rg) markRanges(el, side === "a" ? rg.a : rg.b);
    return h("td", { class: "code" }, el);
  };
  const num = (n: number | undefined, base: number | undefined) => h("td", { class: "ln" }, n === undefined || base === undefined ? "" : String(base + n));
  const mk = (t: string) => h("td", { class: "mk", "aria-hidden": t ? undefined : "true" }, t ? h("span", { class: "dmark" }, t) : "");

  const draw = () => {
    if (!a && !b) return;
    const table = h("table", { class: `codediff-table ${unified ? "unified" : "split"}` });
    if (!unified) table.appendChild(h("colgroup", null, h("col", { class: "c-ln" }), h("col", { class: "c-mk" }), h("col", { class: "c-code" }), h("col", { class: "c-ln" }), h("col", { class: "c-mk" }), h("col", { class: "c-code" })));
    else table.appendChild(h("colgroup", null, h("col", { class: "c-ln" }), h("col", { class: "c-ln" }), h("col", { class: "c-mk" }), h("col", { class: "c-code" })));
    const tbody = h("tbody");
    const show = visibleRows(rows, changedOnly ? 3 : Infinity);
    for (const item of show) {
      if (typeof item === "object" && "fold" in item) {
        const btn = h("button", { type: "button", class: "fold-btn", onClick: () => {
          const extra = rows.slice(item.from, item.to);
          const frag = document.createDocumentFragment();
          for (const r of extra) frag.append(...rowEls(r));
          tr.replaceWith(frag);
        } }, icon("plus"), ` ${plural(item.to - item.from, "unchanged line")}`);
        const tr = h("tr", { class: "fold" }, h("td", { colspan: unified ? 4 : 6 }, btn));
        tbody.appendChild(tr);
        continue;
      }
      tbody.append(...rowEls(item));
    }
    table.appendChild(tbody);
    body.replaceChildren(h("div", { class: "codediff-heads" + (unified ? " unified" : "") }, sideHead("old", cmp.oldTitle, a), unified ? null : sideHead("new", cmp.newTitle, b)), h("div", { class: "codediff-scroll" }, table));
  };
  const sideHead = (which: Which, title: string, s: SourceSide | null) => h("div", { class: `side-head side-${which}` }, which === "old" ? "Old" : "New", h("span", { class: "faint" }, ` · ${title}`), s ? h("span", { class: "faint small mono" }, ` ${s.where}`) : h("span", { class: "faint small" }, " (none)"), unified && b ? [h("span", { class: "faint" }, " → "), "New", h("span", { class: "faint" }, ` · ${cmp.newTitle}`), h("span", { class: "faint small mono" }, ` ${b.where}`)] : null);
  const rowEls = (r: Row): HTMLElement[] => {
    const cls = `cd-${r.t}`;
    if (!unified) return [h("tr", { class: cls }, num(r.a, a?.startLine), mk(r.t === "eq" || r.t === "ins" ? "" : MK[r.t]), code("a", r, r.a), num(r.b, b?.startLine), mk(r.t === "eq" || r.t === "del" ? "" : MK[r.t]), code("b", r, r.b))];
    if (r.t === "eq") return [h("tr", { class: cls }, num(r.a, a?.startLine), num(r.b, b?.startLine), mk(""), code("b", r, r.b))];
    const out: HTMLElement[] = [];
    if (r.a !== undefined) out.push(h("tr", { class: "cd-del" + (r.t === "chg" ? " cd-pair" : "") }, num(r.a, a?.startLine), h("td", { class: "ln" }), mk("−"), code("a", r, r.a)));
    if (r.b !== undefined) out.push(h("tr", { class: "cd-ins" + (r.t === "chg" ? " cd-pair" : "") }, h("td", { class: "ln" }), num(r.b, b?.startLine), mk("+"), code("b", r, r.b)));
    return out;
  };

  const load = async () => {
    const [ra, rb] = await Promise.all([loadSide(ctx, cmp, "old", c.old?.id), loadSide(ctx, cmp, "new", c.new?.id)]);
    const problems = [ra, rb].filter((x): x is string => typeof x === "string");
    a = typeof ra === "object" ? ra : null;
    b = typeof rb === "object" ? rb : null;
    if (!a && !b) {
      body.replaceChildren(...(problems.length ? problems : ["No source is known for it."]).map((p) => h("p", { class: "muted small" }, p)));
      return;
    }
    const ta = a ? a.text.split("\n") : [];
    const tb = b ? b.text.split("\n") : [];
    // Lines differing only in indentation or spacing count as the same.
    const norm = (l: string) => l.trim().replace(/\s+/g, " ");
    rows = pairRows(diffSeq(ta.map(norm), tb.map(norm)));
    ranges = new Map();
    rows.forEach((r, i) => {
      if (r.t === "chg") ranges.set(i, intraLine(ta[r.a!], tb[r.b!]));
    });
    const n = (t: string) => rows.filter((r) => r.t === t).length;
    counts.replaceChildren(h("span", { class: "dmark d-added" }, "+"), ` ${n("ins")} added · `, h("span", { class: "dmark d-removed" }, "−"), ` ${n("del")} removed · `, h("span", { class: "dmark d-changed" }, "~"), ` ${plural(n("chg"), "changed line")}`);
    draw();
    for (const p of problems) body.prepend(h("p", { class: "muted small" }, p));
  };
  whenVisible(wrap, () => void load());
  return wrap;
}

/** Changed rows with `context` unchanged lines around them; longer unchanged stretches fold. */
function visibleRows(rows: Row[], context: number): (Row | { fold: true; from: number; to: number })[] {
  if (!Number.isFinite(context)) return rows;
  const keep = new Uint8Array(rows.length);
  rows.forEach((r, i) => {
    if (r.t === "eq") return;
    for (let j = Math.max(0, i - context); j <= Math.min(rows.length - 1, i + context); j++) keep[j] = 1;
  });
  if (!keep.some(Boolean)) return rows;
  const out: (Row | { fold: true; from: number; to: number })[] = [];
  for (let i = 0; i < rows.length; ) {
    if (keep[i]) {
      out.push(rows[i++]);
      continue;
    }
    let j = i;
    while (j < rows.length && !keep[j]) j++;
    if (j - i <= 2) for (let k = i; k < j; k++) out.push(rows[k]);
    else out.push({ fold: true, from: i, to: j });
    i = j;
  }
  return out;
}

/** Give the links of a cloned line the behaviour of the original's. */
function rewire(clone: HTMLElement, orig: HTMLElement): void {
  const a = clone.querySelectorAll("a");
  const b = orig.querySelectorAll("a");
  a.forEach((el, i) => el.addEventListener("click", (ev) => {
    const me = ev as MouseEvent;
    if (me.metaKey || me.ctrlKey || me.shiftKey) return;
    ev.preventDefault();
    b[i]?.dispatchEvent(new MouseEvent("click", { bubbles: false, cancelable: true }));
  }));
}

// ---- a page of the earlier version -------------------------------------------

/** A component of the earlier version, shown as a normal page of that version. */
export function oldVersionBanner(ctx: AppCtx, cmp: Compare, id: Id, diffLink: (c: ComponentDiff) => Child): HTMLElement {
  const m = cmp.old;
  const c = m.comp(id);
  const cd = cmp.byOld.get(id);
  const later = c.parent === undefined && c.name ? cmp.cur.find(KIND_SLUG[c.kind], m.qname(id)) : undefined;
  return h(
    "div",
    { class: `diff-banner side-old${cd ? ` d-${cd.status}` : ""}` },
    h("span", { class: "dmark d-removed", "aria-hidden": "true" }, "◀"),
    h("span", null, "You are looking at ", h("strong", null, cmp.oldTitle), ", the earlier version. Links lead to its pages."),
    cd ? diffLink(cd) : c.parent === undefined ? h("span", { class: "faint small" }, "Unchanged.") : null,
    later !== undefined ? button(`Open in ${cmp.newTitle}`, () => ctx.go(later), { icon: "external", cls: "small" }) : c.parent === undefined ? h("span", { class: "faint small" }, `Not in ${cmp.newTitle}.`) : null
  );
}

