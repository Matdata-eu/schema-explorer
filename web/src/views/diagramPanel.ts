// The diagram and the content-model tree, each with its toolbar: options,
// zoom, full screen, export. Layout runs only once the panel is on screen.
import type { AppCtx } from "../ctx";
import { Diagram, type NodeAction, type View } from "../diagram";
import { button, copyText, h, icon } from "../dom";
import { buildNeighborhood, defaultNeighborhood, toMermaid, toPlantUml, type GraphSpec, type NeighborhoodOptions } from "../graph";
import type { Id } from "../model";
import { TreeView, rootNode, setTreeDiff, type TNode } from "../tree";
import { annotateGraph } from "../diff";

/** What a click on a box in a diagram offers. */
export function boxActions(ctx: AppCtx, id: Id, expand?: { expanded: boolean; toggle: () => void }): NodeAction[] {
  const actions: NodeAction[] = [];
  const c = ctx.m.comp(id);
  if (expand) actions.push({ label: expand.expanded ? "Remove its neighbours" : "Add its neighbours to this diagram", icon: expand.expanded ? "minus" : "plus", run: expand.toggle });
  if (c.kind === "complexType") {
    actions.push({ label: "Open its diagram", icon: "diagram", run: () => ctx.go(id, { tab: "diagram" }) });
    actions.push({ label: "Open its content tree", icon: "tree", run: () => ctx.go(id, { tab: "tree" }) });
  } else actions.push({ label: "Open its page", icon: "external", run: () => ctx.go(id) });
  return actions;
}

/** A button that gives the panel the whole screen, and back. */
export function fullscreenButton(wrap: HTMLElement): HTMLButtonElement {
  const isFull = () => wrap.matches(":fullscreen") || wrap.classList.contains("fs");
  const sync = () => {
    const full = isFull();
    btn.replaceChildren(icon(full ? "minimize" : "maximize"));
    btn.title = full ? "Leave full screen (Esc)" : "Full screen";
    btn.setAttribute("aria-pressed", String(full));
  };
  const btn = button("", () => {
    if (isFull()) {
      if (wrap.classList.contains("fs")) wrap.classList.remove("fs");
      else void document.exitFullscreen();
    } else if (wrap.requestFullscreen) {
      wrap.requestFullscreen().catch(() => wrap.classList.add("fs"));
    } else wrap.classList.add("fs");
    setTimeout(sync, 100);
  }, { cls: "small icon-only", icon: "maximize", title: "Full screen" });
  wrap.addEventListener("fullscreenchange", sync);
  wrap.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && wrap.classList.contains("fs")) {
      wrap.classList.remove("fs");
      sync();
    }
  });
  return btn;
}

/** The pan and zoom kept in a link ("tx,ty,scale"). */
export const viewParam = (v: View | null): string | undefined => (v ? [v.tx, v.ty, v.scale].map((n) => +n.toFixed(3)).join(",") : undefined);
export function parseView(s: string | undefined): View | undefined {
  const n = (s ?? "").split(",").map(Number);
  return n.length === 3 && n.every(Number.isFinite) && n[2] > 0 ? { tx: n[0], ty: n[1], scale: n[2] } : undefined;
}

/** Run `fn` once the element is (nearly) visible: big pages lay out only what is seen. */
export function whenVisible(el: HTMLElement, fn: () => void): void {
  if (typeof IntersectionObserver === "undefined") {
    queueMicrotask(fn);
    return;
  }
  const io = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) {
      io.disconnect();
      fn();
    }
  }, { rootMargin: "200px" });
  io.observe(el);
}

const zoomButtons = (d: Diagram) =>
  h("div", { class: "btn-group" }, button("", () => d.zoomBy(1.25), { cls: "small icon-only", icon: "plus", title: "Zoom in" }), button("", () => d.zoomBy(0.8), { cls: "small icon-only", icon: "minus", title: "Zoom out" }), button("", () => d.fit(), { cls: "small icon-only", icon: "fit", title: "Fit" }));

const idsParam = (set: Set<Id>) => [...set].join(" ");
const parseIds = (s: string | undefined, max: number) => new Set((s ?? "").split(" ").filter(Boolean).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < max));

/** The class diagram of a complex type and its neighbours. */
export function diagramPanel(ctx: AppCtx, focus: Id, opts: { tall?: boolean } = {}): HTMLElement {
  const m = ctx.m;
  const p = ctx.prefs;
  const P = ctx.route.params;
  const flag = (k: string, def: boolean) => (P[k] === undefined ? def : P[k] === "1");
  const base = defaultNeighborhood(focus);
  const o: NeighborhoodOptions = {
    ...base,
    depth: P.depth === "2" ? 2 : P.depth === "1" ? 1 : p.depth,
    inherited: flag("inh", false),
    incoming: flag("inc", p.incoming),
    derived: flag("sub", base.derived),
    enums: flag("enum", p.enums),
    expanded: parseIds(P.x, m.c.length),
    openAttrs: parseIds(P.open, m.c.length),
  };
  let direction: "DOWN" | "RIGHT" = P.dir === "right" ? "RIGHT" : P.dir === "down" ? "DOWN" : p.direction;
  let view: View | undefined = parseView(P.view);
  let restoreView = view !== undefined;
  const bit = (v: boolean) => (v ? "1" : "0");
  const sync = () =>
    ctx.setParams({ depth: String(o.depth), dir: direction.toLowerCase(), inh: bit(o.inherited), inc: bit(o.incoming), sub: bit(o.derived), enum: bit(o.enums), x: idsParam(o.expanded), open: idsParam(o.openAttrs), view: viewParam(view ?? null) });
  const wrap = h("div", { class: `diagram${opts.tall ? " tall" : ""}` });
  const statusText = h("span");
  const status = h("div", { class: "status" }, statusText, h("div", { class: "legend hide-mobile" }, h("span", { class: "gen" }, "extends"), h("span", { class: "restr" }, "restricts"), h("span", { class: "comp" }, "contains"), h("span", { class: "dep" }, "uses")));
  const overlay = h("div", { class: "overlay" }, "Laying out…");
  const expand = (id: Id) => {
    if (o.expanded.has(id)) o.expanded.delete(id);
    else o.expanded.add(id);
    run(true);
  };
  const d = new Diagram(wrap, {
    onNavigate: (id) => ctx.go(id),
    onExpand: (id) => (m.comp(id).kind === "complexType" ? expand(id) : ctx.go(id)),
    nodeMenu: (id) => boxActions(ctx, id, id === focus || m.comp(id).kind !== "complexType" ? undefined : { expanded: o.expanded.has(id), toggle: () => expand(id) }),
    onToggleAttrs: (id) => {
      if (o.openAttrs.has(id)) o.openAttrs.delete(id);
      else o.openAttrs.add(id);
      run(true);
    },
    onStatus: (t) => (statusText.textContent = t),
    onViewChange: (v) => {
      view = v ?? undefined;
      sync();
    },
  });
  let graph: GraphSpec | null = null;
  let started = false;
  const run = (keepView = false) => {
    if (!started) return;
    wrap.appendChild(overlay);
    graph = buildNeighborhood(m, o);
    if (ctx.cmp) annotateGraph(graph, ctx.cmp);
    const start = restoreView ? view : undefined;
    restoreView = false;
    sync();
    d.render(graph, { direction, keepView, view: start }).finally(() => overlay.remove());
  };
  const toggle = (label: string, get: () => boolean, set: (v: boolean) => void, title?: string) => {
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
    ctx.setPrefs({ depth: o.depth });
    run(false);
  }, { cls: "small", title: "How many steps away from this type to show" });
  const dirBtn = button("", () => {
    direction = direction === "DOWN" ? "RIGHT" : "DOWN";
    ctx.setPrefs({ direction });
    run(false);
  }, { cls: "small icon-only", icon: "tree", title: "Flip the layout direction" });
  const { exportBtn, exportMenu } = exportControls(ctx, d, m.label(focus), () => (graph ? { plantuml: toPlantUml(graph), mermaid: toMermaid(graph) } : null), wrap);
  const tools = h(
    "div",
    { class: "dtools" },
    depthBtn,
    toggle("Inherited", () => o.inherited, (v) => {
      o.inherited = v;
    }, "List inherited attributes and child elements in this type's box"),
    toggle("Used by", () => o.incoming, (v) => {
      o.incoming = v;
      ctx.setPrefs({ incoming: v });
    }, "Show the types and elements that use this type"),
    toggle("Derived", () => o.derived, (v) => (o.derived = v), "Show the types derived from this one"),
    toggle("Enumerations", () => o.enums, (v) => {
      o.enums = v;
      ctx.setPrefs({ enums: v });
    }, "Show enumerated simple types as boxes"),
    dirBtn,
    h("span", { class: "spacer" }),
    zoomButtons(d),
    fullscreenButton(wrap),
    exportBtn
  );
  wrap.append(tools, exportMenu, status, overlay);
  refitOnResize(wrap, d);
  whenVisible(wrap, () => {
    started = true;
    run(false);
  });
  return wrap;
}

/** The content-model tree of an element, a complex type or a group. */
export function treePanel(ctx: AppCtx, focus: Id): HTMLElement {
  const m = ctx.m;
  const P = ctx.route.params;
  const open = new Set((P.tree ?? "").split(" ").filter(Boolean));
  let view: View | undefined = parseView(P.view);
  let restoreView = view !== undefined;
  const sync = () => ctx.setParams({ tree: [...open].join(" ") || undefined, view: viewParam(view ?? null) });
  const wrap = h("div", { class: "diagram tall" });
  const statusText = h("span");
  const status = h("div", { class: "status" }, statusText, h("div", { class: "legend hide-mobile" }, h("span", { class: "dashed" }, "optional"), h("span", { class: "stacked" }, "repeated")));
  setTreeDiff(ctx.cmp);
  const root = rootNode(m, focus);
  let started = false;
  const toggleNode = (n: TNode, isOpen: boolean) => {
    const compositor = n.kind === "sequence" || n.kind === "choice" || n.kind === "all" || n.kind === "type";
    if (compositor) {
      if (isOpen) open.delete("-" + n.key);
      else open.add("-" + n.key);
    } else if (isOpen) open.add(n.key);
    else open.delete(n.key);
    run(true);
  };
  const t: TreeView = new TreeView(wrap, {
    onToggle: toggleNode,
    actions: (n: TNode) => {
      const a: NodeAction[] = [];
      if (n.expandable && n.kind !== "type") {
        const isOpen = n.kind === "sequence" || n.kind === "choice" || n.kind === "all" ? !open.has("-" + n.key) : open.has(n.key);
        a.push({ label: isOpen ? "Collapse" : "Expand", icon: isOpen ? "minus" : "plus", run: () => toggleNode(n, !isOpen) });
      }
      if (n.kind === "element" && n.expandable) a.push({ label: "Expand all below (3 levels)", icon: "plus", run: () => {
        expandBelow(n, 3);
        run(true);
      } });
      if (n.id !== undefined && n.id !== focus) a.push({ label: n.kind === "group" ? "Open the group" : "Open the element", icon: "external", run: () => ctx.go(n.id!) });
      if (n.typeId !== undefined && n.typeId !== focus && !m.comp(n.typeId).builtin) a.push({ label: `Open the type ${m.label(n.typeId)}`, icon: "external", run: () => ctx.go(n.typeId!) });
      if (n.typeId !== undefined && m.comp(n.typeId).kind === "complexType" && n.typeId !== focus) a.push({ label: "Its content tree", icon: "tree", run: () => ctx.go(n.typeId!, { tab: "tree" }) });
      return a;
    },
    onStatus: (s) => (statusText.textContent = s),
    onViewChange: (v) => {
      view = v ?? undefined;
      sync();
    },
  });
  const expandBelow = (n: TNode, levels: number) => {
    if (levels <= 0 || !n.expandable) return;
    if (n.kind === "element" || n.kind === "group") open.add(n.key);
    for (const c of n.children()) expandBelow(c, c.kind === "element" ? levels - 1 : levels);
  };
  const run = (keepView = false) => {
    if (!started) return;
    const start = restoreView ? view : undefined;
    restoreView = false;
    t.show(root, open, { keepView, view: start });
    sync();
  };
  const collapse = button("Collapse all", () => {
    open.clear();
    run(false);
  }, { cls: "small", title: "Back to the first level" });
  const expandAll = button("Expand 2 levels", () => {
    expandBelow(root, 2);
    run(false);
  }, { cls: "small", title: "Open the child elements two levels deep" });
  const { exportBtn, exportMenu } = exportControls(ctx, t, `${m.label(focus)}-tree`, null, wrap);
  wrap.append(h("div", { class: "dtools" }, expandAll, collapse, h("span", { class: "spacer" }), zoomButtons(t), fullscreenButton(wrap), exportBtn), exportMenu, status);
  refitOnResize(wrap, t);
  whenVisible(wrap, () => {
    started = true;
    run(false);
  });
  return wrap;
}

/** The Export button and its menu: images, PlantUML, Mermaid and the link to the view. */
export function exportControls(ctx: AppCtx, d: Diagram, label: string, text: (() => { plantuml: string; mermaid: string } | null) | null, wrap: HTMLElement) {
  const exportMenu = h("div", { class: "menu", hidden: true });
  const exportBtn = button("Export", () => {
    exportMenu.hidden = !exportMenu.hidden;
    exportMenu.style.top = "44px";
    exportMenu.style.right = "8px";
  }, { cls: "small", icon: "download" });
  const name = label.replace(/[^\w.-]+/g, "_");
  const item = (t: string, fn: () => void) =>
    h("button", { type: "button", onClick: () => {
      exportMenu.hidden = true;
      fn();
    } }, t);
  const copy = (what: string, t: string | undefined) => {
    if (t !== undefined) void copyText(t).then((ok) => ctx.toast(ok ? `${what} copied` : "Could not copy"));
  };
  exportMenu.append(
    h("div", { class: "mh" }, "Export"),
    item("SVG image", () => d.downloadSvg(name)),
    item("PNG image (2×)", () => d.downloadPng(name)),
    item("Copy link to this view", () => copy("Link", ctx.shareLink().url))
  );
  if (text) exportMenu.insertBefore(item("Copy PlantUML", () => copy("PlantUML", text()?.plantuml)), exportMenu.lastChild);
  if (text) exportMenu.insertBefore(item("Copy Mermaid", () => copy("Mermaid", text()?.mermaid)), exportMenu.lastChild);
  wrap.addEventListener("click", (ev) => {
    if (!exportMenu.hidden && !exportMenu.contains(ev.target as Node) && !exportBtn.contains(ev.target as Node)) exportMenu.hidden = true;
  });
  return { exportBtn, exportMenu };
}

/** Re-fit when the panel is resized by the user (CSS resize handle). */
export function refitOnResize(wrap: HTMLElement, d: Diagram): void {
  let last = 0;
  new ResizeObserver(() => {
    const now = wrap.clientHeight;
    if (Math.abs(now - last) > 4) {
      if (last !== 0) d.fit();
      last = now;
    }
  }).observe(wrap);
}

/** A small diagram built by `build` (simple types): layout, zoom, full screen and export. */
export function smallDiagram(ctx: AppCtx, focus: Id, build: () => GraphSpec, legend: string): HTMLElement {
  const P = ctx.route.params;
  let direction: "DOWN" | "RIGHT" = P.dir === "right" ? "RIGHT" : P.dir === "down" ? "DOWN" : ctx.prefs.direction;
  const wrap = h("div", { class: "diagram small-diagram" });
  const statusText = h("span");
  const status = h("div", { class: "status" }, statusText, h("div", { class: "legend hide-mobile" }, legend));
  const overlay = h("div", { class: "overlay" }, "Laying out…");
  let graph: GraphSpec | null = null;
  const d = new Diagram(wrap, { onNavigate: (id) => id !== focus && ctx.go(id), nodeMenu: (id) => (id === focus ? [] : boxActions(ctx, id)), onStatus: (t) => (statusText.textContent = t) });
  const run = () => {
    wrap.appendChild(overlay);
    graph = build();
    ctx.setParams({ dir: direction.toLowerCase() });
    d.render(graph, { direction }).finally(() => overlay.remove());
  };
  const dirBtn = button("", () => {
    direction = direction === "DOWN" ? "RIGHT" : "DOWN";
    ctx.setPrefs({ direction });
    run();
  }, { cls: "small icon-only", icon: "tree", title: "Flip the layout direction" });
  const { exportBtn, exportMenu } = exportControls(ctx, d, ctx.m.label(focus), () => (graph ? { plantuml: toPlantUml(graph), mermaid: toMermaid(graph) } : null), wrap);
  wrap.append(h("div", { class: "dtools" }, dirBtn, h("span", { class: "spacer" }), zoomButtons(d), fullscreenButton(wrap), exportBtn), exportMenu, status, overlay);
  whenVisible(wrap, run);
  return wrap;
}
