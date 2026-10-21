// Draws a GraphSpec as a UML-style SVG: ELK for layout, hand-made rendering,
// pan and zoom, highlighting, SVG and PNG export. The content-model tree
// reuses the canvas (pan, zoom, export) with its own drawing, see drawRaw.
import { clear, downloadBlob, icon, s } from "./dom";
import type { AttrLine, EdgeSpec, GraphSpec, NodeSpec } from "./graph";
import { layout, type ElkNode } from "./layout";

export const SANS = 'Barlow, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
export const MONO = '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const FONT = `12.5px ${SANS}`;
const NAME_FONT = `600 14px ${SANS}`;
const STEREO_FONT = `11px ${SANS}`;
const LINE = 17;
const PAD_X = 12;
const HEAD_H = 30;
const STEREO_H = 14;
const MIN_W = 120;
const MAX_W = 320;

let ctx: CanvasRenderingContext2D | null = null;
export function measure(text: string, font = FONT): number {
  if (!ctx) {
    const c = document.createElement("canvas");
    ctx = c.getContext("2d");
  }
  if (!ctx) return text.length * 7;
  ctx.font = font;
  return ctx.measureText(text).width;
}

const EDGE_FONT = `11px ${MONO}`;
/** Long property names would stretch the layout; the full name shows on hover. */
function edgeLabel(text: string): string {
  return ellipsize(text, 170, EDGE_FONT);
}

function ellipsize(text: string, max: number, font = FONT): string {
  if (measure(text, font) <= max) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measure(text.slice(0, mid) + "…", font) <= max) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, Math.max(1, lo)) + "…";
}

export interface Sized {
  w: number;
  h: number;
  /** Rows of (group header | attribute) in display order. */
  rows: ({ header: string } | AttrLine)[];
}

function attrText(a: AttrLine): string {
  return `${a.text}${a.type ? " : " + a.type : ""}${a.mult ? " [" + a.mult + "]" : ""}`;
}

function size(n: NodeSpec): Sized {
  const rows: ({ header: string } | AttrLine)[] = [];
  let group: string | undefined;
  for (const a of n.attrs) {
    if (a.groupKey !== group) {
      group = a.groupKey;
      if (a.group) rows.push({ header: a.group });
    }
    rows.push(a);
  }
  let w = Math.max(MIN_W, measure(n.name, NAME_FONT) + PAD_X * 2 + 8);
  if (n.stereotype) w = Math.max(w, measure(n.stereotype, STEREO_FONT) + PAD_X * 2);
  for (const r of rows) w = Math.max(w, measure("header" in r ? r.header : attrText(r)) + PAD_X * 2 + 4);
  if (n.hiddenAttrs) w = Math.max(w, measure(`+${n.hiddenAttrs} more…`) + PAD_X * 2);
  w = Math.min(MAX_W, Math.ceil(w));
  let h = HEAD_H + (n.stereotype ? STEREO_H : 0);
  const body = rows.length + (n.hiddenAttrs ? 1 : 0);
  if (body > 0) h += body * LINE + 8;
  else if (n.kind !== "more") h += 6;
  return { w, h: Math.ceil(h), rows };
}

export interface DiagramCallbacks {
  onNavigate?: (id: number) => void;
  onExpand?: (id: number) => void;
  onToggleAttrs?: (id: number) => void;
  onMore?: (ids: number[], relation: string) => void;
  onStatus?: (text: string) => void;
  /** Pan and zoom changed by the user (null: back to "fit"), for links to the view. */
  onViewChange?: (view: View | null) => void;
  /** Actions offered when a box is clicked. Without them, a click opens the entity. */
  nodeMenu?: (id: number) => NodeAction[];
  /** Every pan and zoom by the user, at once (to move a linked diagram along). */
  onTransform?: (view: View) => void;
}

export interface View {
  tx: number;
  ty: number;
  scale: number;
}

export interface NodeAction {
  label: string;
  icon?: string;
  run: () => void;
}

export interface RenderOptions {
  direction: "DOWN" | "RIGHT";
  /** Keep the current pan/zoom when re-rendering. */
  keepView?: boolean;
  /** Start from this pan and zoom instead of fitting the diagram. */
  view?: View;
  /** Use ELK's stress layout (for maps) instead of layered. */
  algorithm?: "layered" | "stress";
  /**
   * Positions from a layout of a bigger graph (compare mode: both versions
   * together), so boxes sit at the same place in two diagrams. Only the
   * boxes and lines of `spec` are drawn, each at the size of the bigger graph.
   */
  shared?: Promise<LaidGraph>;
}

/** A graph laid out by ELK and the box sizes it was given. */
export interface LaidGraph {
  laid: ElkNode;
  sizes: Map<string, Sized>;
}

/** Lay out a graph with ELK, boxes sized by their text. */
export async function layoutGraph(spec: GraphSpec, opts: { direction: "DOWN" | "RIGHT"; algorithm?: "layered" | "stress" }): Promise<LaidGraph> {
  await document.fonts?.ready;
  const sizes = new Map<string, Sized>();
  for (const n of spec.nodes) sizes.set(n.key, size(n));
  const algorithm = opts.algorithm ?? "layered";
  const elkGraph: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": algorithm,
      "elk.direction": opts.direction,
      "elk.spacing.nodeNode": algorithm === "stress" ? "60" : "36",
      "elk.layered.spacing.nodeNodeBetweenLayers": "70",
      "elk.layered.spacing.edgeNodeBetweenLayers": "30",
      "elk.spacing.edgeNode": "24",
      "elk.spacing.edgeEdge": "16",
      "elk.spacing.edgeLabel": "6",
      "elk.edgeRouting": algorithm === "stress" ? "POLYLINE" : "ORTHOGONAL",
      "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.layered.crossingMinimization.semiInteractive": "true",
      "elk.layered.mergeEdges": "false",
      "elk.edgeLabels.inline": "false",
      "elk.stress.desiredEdgeLength": "180",
      "elk.padding": "[top=20,left=20,bottom=20,right=20]",
    },
    children: spec.nodes.map((n) => {
      const sz = sizes.get(n.key)!;
      return { id: n.key, width: sz.w, height: sz.h };
    }),
    edges: spec.edges.map((e) => ({
      id: e.key,
      // Generalisations are drawn from the super class (source) to the sub
      // class so the hierarchy reads top-down; the triangle sits at the source.
      sources: [e.from],
      targets: [e.to],
      labels: e.label ? [{ text: edgeLabel(e.label), width: Math.ceil(measure(edgeLabel(e.label), EDGE_FONT)) + 6, height: 14 }] : undefined,
      layoutOptions: e.kind === "gen" || e.kind === "restr" ? { "elk.layered.priority.direction": "10" } : undefined,
    })),
  };
  return { laid: await layout(elkGraph), sizes };
}

export class Diagram {
  readonly svg: SVGSVGElement;
  protected viewport: SVGGElement;
  protected host: HTMLElement;
  protected cb: DiagramCallbacks;
  protected scale = 1;
  protected tx = 0;
  protected ty = 0;
  protected content = { w: 0, h: 0 };
  protected spec: GraphSpec | null = null;
  protected seq = 0;

  constructor(host: HTMLElement, cb: DiagramCallbacks) {
    this.host = host;
    this.cb = cb;
    this.svg = s("svg", { class: "canvas uml", role: "img" });
    this.svg.appendChild(this.defs());
    this.viewport = s("g", { class: "viewport" });
    this.svg.appendChild(this.viewport);
    host.appendChild(this.svg);
    this.wireInteraction();
  }

  private defs(): SVGDefsElement {
    const d = s("defs");
    const marker = (id: string, path: SVGPathElement, w = 12, h = 12, refX = 11, refY = 6) => {
      const m = s("marker", { id, markerWidth: w, markerHeight: h, refX, refY, orient: "auto-start-reverse", markerUnits: "userSpaceOnUse" });
      m.appendChild(path);
      d.appendChild(m);
    };
    marker("m-tri", s("path", { class: "tri", d: "M1 1L11 6L1 11z" }), 13, 13, 11, 6);
    marker("m-arrow", s("path", { class: "arrow", d: "M2 2L10 6L2 10" }), 12, 12, 10, 6);
    marker("m-arrow-dep", s("path", { class: "arrow-dep", d: "M2 2L10 6L2 10" }), 12, 12, 10, 6);
    marker("m-diamond", s("path", { class: "diamond", d: "M1 6L7 1L13 6L7 11z" }), 14, 12, 1, 6);
    return d;
  }

  get graph(): GraphSpec | null {
    return this.spec;
  }

  async render(spec: GraphSpec, opts: RenderOptions): Promise<void> {
    const my = ++this.seq;
    this.spec = spec;
    this.closeMenu();
    let laid: ElkNode;
    let sizes: Map<string, Sized>;
    try {
      if (opts.shared) {
        const shared = await opts.shared;
        laid = shared.laid;
        // Each box shows its own lines in the room the bigger graph gave it.
        sizes = new Map(spec.nodes.map((n) => {
          const own = size(n);
          const room = shared.sizes.get(n.key);
          return [n.key, room ? { ...own, w: room.w, h: room.h } : own];
        }));
      } else ({ laid, sizes } = await layoutGraph(spec, opts));
    } catch (e) {
      this.cb.onStatus?.(`layout failed: ${(e as Error).message}`);
      return;
    }
    if (my !== this.seq) return;
    this.draw(spec, laid, sizes);
    if (opts.view) {
      ({ tx: this.tx, ty: this.ty, scale: this.scale } = opts.view);
      this.applyTransform(false);
    } else if (!opts.keepView) this.fit();
    else this.applyTransform(false);
  }

  private draw(spec: GraphSpec, laid: ElkNode, sizes: Map<string, Sized>): void {
    clear(this.viewport);
    this.focusAt = null;
    const pos = new Map<string, { x: number; y: number }>();
    let maxX = 0;
    let maxY = 0;
    for (const c of laid.children ?? []) {
      pos.set(c.id, { x: c.x ?? 0, y: c.y ?? 0 });
      maxX = Math.max(maxX, (c.x ?? 0) + (c.width ?? 0));
      maxY = Math.max(maxY, (c.y ?? 0) + (c.height ?? 0));
    }
    const edgesG = s("g", { class: "edges" });
    const nodesG = s("g", { class: "nodes" });
    this.viewport.append(edgesG, nodesG);
    const byKey = new Map(spec.edges.map((e) => [e.key, e]));
    for (const le of laid.edges ?? []) {
      const e = byKey.get(le.id);
      if (!e) continue;
      const g = this.drawEdge(e, le);
      if (g) edgesG.appendChild(g);
      for (const l of le.labels ?? []) {
        maxX = Math.max(maxX, (l.x ?? 0) + (l.width ?? 0));
        maxY = Math.max(maxY, (l.y ?? 0) + (l.height ?? 0));
      }
    }
    for (const n of spec.nodes) {
      const p = pos.get(n.key);
      const sz = sizes.get(n.key);
      if (!p || !sz) continue;
      nodesG.appendChild(this.drawNode(n, p.x, p.y, sz));
      if (n.focus) this.focusAt = { x: p.x + sz.w / 2, y: p.y + sz.h / 2 };
    }
    this.content = { w: maxX + 20, h: maxY + 20 };
    this.cb.onStatus?.(`${spec.nodes.length} boxes, ${spec.edges.length} arrows${spec.omitted ? `, ${spec.omitted} neighbours not shown` : ""}`);
  }

  private drawEdge(e: EdgeSpec, le: NonNullable<ElkNode["edges"]>[number]): SVGGElement | null {
    const sec = le.sections?.[0];
    if (!sec) return null;
    const pts = [sec.startPoint, ...(sec.bendPoints ?? []), sec.endPoint];
    const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
    const g = s("g", { class: `edge ${e.kind}${e.diff ? ` d-${e.diff}` : ""}`, "data-from": e.from, "data-to": e.to });
    const path = s("path", { d });
    switch (e.kind) {
      case "gen":
      case "restr":
        path.setAttribute("marker-start", "url(#m-tri)");
        break;
      case "comp":
        path.setAttribute("marker-start", "url(#m-diamond)");
        path.setAttribute("marker-end", "url(#m-arrow)");
        break;
      case "dep":
      case "typed":
        path.setAttribute("marker-end", "url(#m-arrow-dep)");
        break;
      default:
        path.setAttribute("marker-end", "url(#m-arrow)");
    }
    g.appendChild(path);
    // A wider invisible path makes hovering easier.
    g.appendChild(s("path", { d, style: { stroke: "transparent", strokeWidth: "10", fill: "none" } }));
    if (e.label) {
      const l = le.labels?.[0];
      const x = l ? (l.x ?? 0) + (l.width ?? 0) / 2 : (pts[0].x + pts[pts.length - 1].x) / 2;
      const y = l ? (l.y ?? 0) + (l.height ?? 0) / 2 : (pts[0].y + pts[pts.length - 1].y) / 2;
      const t = s("text", { x, y, "text-anchor": "middle" }, edgeLabel(e.label));
      if (t.textContent !== e.label) t.appendChild(s("title", null, e.label));
      g.appendChild(t);
    }
    if (e.mult) {
      // Multiplicity near the target end.
      const end = pts[pts.length - 1];
      const prev = pts[pts.length - 2] ?? end;
      const dx = Math.sign(end.x - prev.x);
      const dy = Math.sign(end.y - prev.y);
      const x = end.x - dx * 14 + (dx === 0 ? 8 : 0);
      const y = end.y - dy * 14 + (dy === 0 ? -8 : 0);
      g.appendChild(s("text", { class: "mult", x, y, "text-anchor": dx === 0 ? "start" : dx > 0 ? "end" : "start" }, e.mult));
    }
    if (e.id !== undefined) {
      g.style.cursor = "pointer";
      g.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this.cb.onNavigate?.(e.id as number);
      });
      g.appendChild(s("title", null, `${e.label ?? ""} ${e.mult ?? ""}`.trim()));
    }
    return g;
  }

  private drawNode(n: NodeSpec, x: number, y: number, sz: Sized): SVGGElement {
    const cls = ["node", n.kind, n.focus ? "focus" : "", n.external ? "external" : "", n.diff ? `d-${n.diff}` : ""].filter(Boolean).join(" ");
    const g = s("g", { class: cls, transform: `translate(${x} ${y})`, "data-key": n.key });
    g.appendChild(s("rect", { class: "box", width: sz.w, height: sz.h, rx: 10 }));
    const headH = HEAD_H + (n.stereotype ? STEREO_H : 0);
    g.appendChild(s("rect", { class: "head", width: sz.w, height: headH, rx: 10 }));
    // Square off the bottom of the head when there is a body.
    if (sz.rows.length || n.hiddenAttrs) g.appendChild(s("rect", { class: "head", y: headH - 10, width: sz.w, height: 10 }));
    let ty = 0;
    if (n.stereotype) {
      g.appendChild(s("text", { class: "stereo", x: sz.w / 2, y: 11 }, ellipsize(n.stereotype, sz.w - 10, STEREO_FONT)));
      ty = STEREO_H;
    }
    const nameCls = ["name", n.abstract ? "abstract" : ""].filter(Boolean).join(" ");
    g.appendChild(s("text", { class: nameCls, x: sz.w / 2, y: ty + HEAD_H / 2 + 1 }, ellipsize(n.name, sz.w - PAD_X * 2, NAME_FONT)));
    if (sz.rows.length || n.hiddenAttrs) {
      g.appendChild(s("line", { class: "sep", x1: 0, y1: headH, x2: sz.w, y2: headH }));
      let yy = headH + 4 + LINE / 2;
      for (const r of sz.rows) {
        if ("header" in r) {
          g.appendChild(s("text", { class: "attr", x: sz.w / 2, y: yy, "text-anchor": "middle", style: { fontStyle: "italic", fill: "var(--se-text-3)" } }, ellipsize(r.header, sz.w - PAD_X * 2)));
        } else {
          const t = s("text", { class: `attr${r.inherited ? " inh" : ""}${r.diff ? ` d-${r.diff}` : ""}`, x: PAD_X, y: yy });
          const full = attrText(r);
          if (measure(full) > sz.w - PAD_X * 2) {
            t.textContent = ellipsize(full, sz.w - PAD_X * 2);
          } else {
            t.appendChild(document.createTextNode(r.text));
            if (r.type) t.appendChild(s("tspan", { class: "type" }, ` : ${r.type}`));
            if (r.mult) t.appendChild(s("tspan", { class: "mult" }, ` [${r.mult}]`));
          }
          if (r.id !== undefined) {
            t.style.cursor = "pointer";
            t.addEventListener("click", (ev) => {
              ev.stopPropagation();
              this.cb.onNavigate?.(r.id as number);
            });
          }
          t.appendChild(s("title", null, full));
          g.appendChild(t);
        }
        yy += LINE;
      }
      if (n.hiddenAttrs) {
        const more = s("text", { class: "more", x: PAD_X, y: yy }, `+${n.hiddenAttrs} more…`);
        more.addEventListener("click", (ev) => {
          ev.stopPropagation();
          if (n.id !== undefined) this.cb.onToggleAttrs?.(n.id);
        });
        g.appendChild(more);
      }
    }
    g.appendChild(s("title", null, `${n.name}${n.stereotype ? " " + n.stereotype : ""}\n${this.cb.nodeMenu ? "click: options" : "click: open"}${this.cb.onExpand ? " · double-click: expand neighbours" : ""}`));
    if (n.kind === "more" && n.moreOf) {
      g.addEventListener("click", () => this.cb.onMore?.(n.moreOf!.ids, n.moreOf!.relation));
    } else if (n.id !== undefined) {
      let clickTimer: ReturnType<typeof setTimeout> | undefined;
      g.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (clickTimer) clearTimeout(clickTimer);
        const { clientX, clientY } = ev;
        clickTimer = setTimeout(() => {
          const actions = this.cb.nodeMenu?.(n.id as number);
          if (actions?.length) this.showMenu(n.name, actions, clientX, clientY);
          else this.cb.onNavigate?.(n.id as number);
        }, 220);
      });
      g.addEventListener("dblclick", (ev) => {
        ev.stopPropagation();
        if (clickTimer) clearTimeout(clickTimer);
        this.cb.onExpand?.(n.id as number);
      });
    }
    g.addEventListener("pointerenter", () => this.highlight(n.key));
    g.addEventListener("pointerleave", () => this.highlight(null));
    return g;
  }

  private menu: HTMLElement | null = null;

  /** The small menu a click on a box opens, at the click position. */
  protected showMenu(title: string, actions: NodeAction[], x: number, y: number): void {
    this.closeMenu();
    const menu = document.createElement("div");
    menu.className = "menu node-menu";
    menu.setAttribute("role", "menu");
    const head = document.createElement("div");
    head.className = "mh";
    head.textContent = title;
    menu.appendChild(head);
    for (const a of actions) {
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "menuitem");
      if (a.icon) b.appendChild(icon(a.icon));
      b.append(a.label);
      b.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this.closeMenu();
        a.run();
      });
      menu.appendChild(b);
    }
    this.host.appendChild(menu);
    const box = this.host.getBoundingClientRect();
    const left = Math.max(4, Math.min(x - box.left + 4, box.width - menu.offsetWidth - 4));
    const top = Math.max(4, Math.min(y - box.top + 4, box.height - menu.offsetHeight - 4));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    this.menu = menu;
    (menu.querySelector("button") as HTMLButtonElement | null)?.focus();
    const away = (ev: Event) => {
      if (ev instanceof KeyboardEvent && ev.key !== "Escape") return;
      if (ev.type === "pointerdown" && ev.composedPath().includes(menu)) return;
      this.closeMenu();
    };
    const root = this.host.getRootNode() as Document | ShadowRoot;
    root.addEventListener("pointerdown", away, true);
    root.addEventListener("keydown", away, true);
    this.svg.addEventListener("wheel", away, { passive: true });
    this.unbindMenu = () => {
      root.removeEventListener("pointerdown", away, true);
      root.removeEventListener("keydown", away, true);
      this.svg.removeEventListener("wheel", away);
    };
  }

  private unbindMenu: (() => void) | null = null;

  closeMenu(): void {
    this.unbindMenu?.();
    this.unbindMenu = null;
    this.menu?.remove();
    this.menu = null;
  }

  private highlight(key: string | null): void {
    const edges = this.viewport.querySelectorAll<SVGGElement>(".edge");
    const nodes = this.viewport.querySelectorAll<SVGGElement>(".node");
    if (!key) {
      edges.forEach((e) => e.classList.remove("dim"));
      nodes.forEach((n) => n.classList.remove("dim"));
      return;
    }
    const linked = new Set<string>([key]);
    edges.forEach((e) => {
      const hit = e.dataset.from === key || e.dataset.to === key;
      e.classList.toggle("dim", !hit);
      if (hit) {
        linked.add(e.dataset.from!);
        linked.add(e.dataset.to!);
      }
    });
    nodes.forEach((n) => n.classList.toggle("dim", !linked.has(n.dataset.key!)));
  }

  /** Draw something else than a graph (the content-model tree) on the same canvas. */
  drawRaw(draw: (viewport: SVGGElement) => { w: number; h: number }, opts: { keepView?: boolean; view?: View } = {}): void {
    this.seq++;
    this.closeMenu();
    clear(this.viewport);
    const size = draw(this.viewport);
    this.content = { w: size.w + 20, h: size.h + 20 };
    if (opts.view) {
      ({ tx: this.tx, ty: this.ty, scale: this.scale } = opts.view);
      this.applyTransform(false);
    } else if (!opts.keepView) this.fit();
    else this.applyTransform(false);
  }

  // ---- pan & zoom ---------------------------------------------------------

  private viewTimer: ReturnType<typeof setTimeout> | undefined;

  /** `byUser`: a pan or zoom worth remembering in the link to this view. */
  protected applyTransform(byUser = true): void {
    this.viewport.setAttribute("transform", `translate(${this.tx} ${this.ty}) scale(${this.scale})`);
    if (byUser) this.cb.onTransform?.(this.view);
    if (byUser && this.cb.onViewChange) {
      clearTimeout(this.viewTimer);
      this.viewTimer = setTimeout(() => this.cb.onViewChange?.({ tx: this.tx, ty: this.ty, scale: this.scale }), 400);
    }
  }

  /** Centre of the focus box, to centre on when the whole diagram would be too small to read. */
  protected focusAt: { x: number; y: number } | null = null;
  /** The smallest scale "fit" goes down to; beyond it the view centres on the focus. */
  minFitScale = 0.45;

  /** The current pan and zoom. */
  get view(): View {
    return { tx: this.tx, ty: this.ty, scale: this.scale };
  }

  /** Pan and zoom to `v` (a linked diagram moved), without telling onTransform. */
  setView(v: View): void {
    ({ tx: this.tx, ty: this.ty, scale: this.scale } = v);
    this.applyTransform(false);
  }

  fit(): void {
    const box = this.svg.getBoundingClientRect();
    if (!box.width || !this.content.w) return;
    // Keep clear of the toolbar on top and the status line at the bottom.
    const top = 48;
    const bottom = 30;
    const sx = (box.width - 24) / this.content.w;
    const sy = (box.height - top - bottom) / this.content.h;
    const want = Math.min(sx, sy);
    this.scale = Math.min(1.1, Math.max(this.focusAt ? this.minFitScale : 0.1, want));
    this.tx = (box.width - this.content.w * this.scale) / 2;
    this.ty = top + Math.max(0, (box.height - top - bottom - this.content.h * this.scale) / 2);
    if (this.focusAt && want < this.scale) {
      // Too big to read whole: keep the focus in view, pan for the rest.
      if (sx < this.scale) this.tx = Math.min(12, Math.max(box.width - 12 - this.content.w * this.scale, box.width / 2 - this.focusAt.x * this.scale));
      if (sy < this.scale) this.ty = Math.min(top, Math.max(box.height - bottom - this.content.h * this.scale, (box.height + top - bottom) / 2 - this.focusAt.y * this.scale));
    }
    this.applyTransform(false);
    clearTimeout(this.viewTimer);
    this.cb.onViewChange?.(null);
  }

  zoomBy(f: number): void {
    const box = this.svg.getBoundingClientRect();
    this.zoomAt(f, box.width / 2, box.height / 2);
  }

  private zoomAt(f: number, px: number, py: number): void {
    const ns = Math.min(4, Math.max(0.1, this.scale * f));
    const k = ns / this.scale;
    this.tx = px - (px - this.tx) * k;
    this.ty = py - (py - this.ty) * k;
    this.scale = ns;
    this.applyTransform();
  }

  private wireInteraction(): void {
    let dragging: { x: number; y: number; tx: number; ty: number; moved: boolean } | null = null;
    const pointers = new Map<number, { x: number; y: number }>();
    let pinch: { d: number; scale: number } | null = null;
    this.svg.addEventListener("pointerdown", (ev) => {
      pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), scale: this.scale };
        dragging = null;
        return;
      }
      dragging = { x: ev.clientX, y: ev.clientY, tx: this.tx, ty: this.ty, moved: false };
    });
    this.svg.addEventListener("pointermove", (ev) => {
      if (pointers.has(ev.pointerId)) pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (pinch && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const box = this.svg.getBoundingClientRect();
        const f = (pinch.scale * (d / pinch.d)) / this.scale;
        this.zoomAt(f, (a.x + b.x) / 2 - box.left, (a.y + b.y) / 2 - box.top);
        return;
      }
      if (!dragging) return;
      const dx = ev.clientX - dragging.x;
      const dy = ev.clientY - dragging.y;
      if (!dragging.moved && Math.abs(dx) + Math.abs(dy) > 3) {
        dragging.moved = true;
        // Capture only once it is a drag: capturing on pointerdown sends the
        // click to the canvas instead of the box under the pointer.
        this.svg.setPointerCapture(ev.pointerId);
      }
      if (!dragging.moved) return;
      this.tx = dragging.tx + dx;
      this.ty = dragging.ty + dy;
      this.applyTransform();
    });
    const up = (ev: PointerEvent) => {
      pointers.delete(ev.pointerId);
      if (pointers.size < 2) pinch = null;
      if (dragging?.moved) {
        // Swallow the click that follows a drag.
        const stop = (e: Event) => {
          e.stopPropagation();
          this.svg.removeEventListener("click", stop, true);
        };
        this.svg.addEventListener("click", stop, true);
        setTimeout(() => this.svg.removeEventListener("click", stop, true), 0);
      }
      dragging = null;
    };
    this.svg.addEventListener("pointerup", up);
    this.svg.addEventListener("pointercancel", up);
    this.svg.addEventListener(
      "wheel",
      (ev) => {
        ev.preventDefault();
        const box = this.svg.getBoundingClientRect();
        const f = Math.exp(-ev.deltaY * (ev.deltaMode === 1 ? 0.05 : 0.0015));
        this.zoomAt(f, ev.clientX - box.left, ev.clientY - box.top);
      },
      { passive: false }
    );
  }

  // ---- export ---------------------------------------------------------

  /** A standalone SVG document with the theme's colours inlined. */
  exportSvg(): string {
    const clone = this.svg.cloneNode(true) as SVGSVGElement;
    clone.removeAttribute("class");
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    const vp = clone.querySelector(".viewport");
    vp?.removeAttribute("transform");
    clone.setAttribute("viewBox", `0 0 ${Math.ceil(this.content.w)} ${Math.ceil(this.content.h)}`);
    clone.setAttribute("width", String(Math.ceil(this.content.w)));
    clone.setAttribute("height", String(Math.ceil(this.content.h)));
    clone.querySelectorAll(".dim").forEach((e) => e.classList.remove("dim"));
    const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
    style.textContent = this.inlineCss();
    clone.insertBefore(style, clone.firstChild);
    const bg = s("rect", { width: "100%", height: "100%", fill: this.cssVar("--se-panel") });
    clone.insertBefore(bg, style.nextSibling);
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(clone);
  }

  protected cssVar(name: string): string {
    const v = getComputedStyle(this.host).getPropertyValue(name).trim();
    return v || "#000";
  }

  private inlineCss(): string {
    const v = (n: string) => this.cssVar(n);
    return `
.node rect.box{fill:${v("--se-panel")};stroke:${v("--se-border-strong")};stroke-width:1}
.node.focus rect.box{stroke:${v("--se-highlight")};stroke-width:3}
.node.external rect.box{stroke-dasharray:4 3}
.node .head{fill:${v("--se-class")}}
.node .head ~ text.name,.node .head ~ text.stereo{fill:${v("--se-on-accent")}}
.node.external .head,.node.enum .head{fill:${v("--se-accent-bg")}}
.node.external .head ~ text.name,.node.enum .head ~ text.name{fill:${v("--se-accent-strong")}}
.node.external .head ~ text.stereo,.node.enum .head ~ text.stereo{fill:${v("--se-accent-strong")}}
.node.element .head{fill:${v("--se-panel-2")}}
.node.element .head ~ text.name{fill:${v("--se-text")}}
.node.element .head ~ text.stereo{fill:${v("--se-text-2")}}
text{font-family:Barlow,system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;font-size:12.5px;fill:${v("--se-text")};dominant-baseline:middle}
text.name{font-weight:600;font-size:14px;text-anchor:middle}
text.name.abstract{font-style:italic}
text.stereo{font-size:11px;text-anchor:middle}
text.attr .type{fill:${v("--se-text-2")}}
text.attr .mult{fill:${v("--se-text-2")}}
text.attr.inh{fill:${v("--se-text-2")}}
text.more{fill:${v("--se-accent")};font-size:12px}
text.deprecated{text-decoration:line-through}
line.sep{stroke:${v("--se-border")};stroke-width:1}
.edge path{fill:none;stroke:${v("--se-border-strong")};stroke-width:1.5}
.edge.gen path{stroke:${v("--se-text")}}
.edge.dep path,.edge.restr path{stroke-dasharray:5 3}
.edge.restr path{stroke:${v("--se-text")}}
.edge.typed path{stroke-dasharray:2 3}
.edge text{font-family:"JetBrains Mono",ui-monospace,Menlo,Consolas,monospace;font-size:11px;fill:${v("--se-text-2")};paint-order:stroke;stroke:${v("--se-panel")};stroke-width:3px;stroke-linejoin:round}
marker path.tri{fill:${v("--se-panel")};stroke:${v("--se-text")};stroke-width:1.5}
marker path.arrow,marker path.arrow-dep{fill:none;stroke:${v("--se-border-strong")};stroke-width:1.5}
marker path.diamond{fill:${v("--se-text")};stroke:${v("--se-text")}}
.node.d-added rect.box{stroke:${v("--se-add")};stroke-width:2.5}
.node.d-changed rect.box{stroke:${v("--se-chg")};stroke-width:2.5}
text.attr.d-added{fill:${v("--se-add")}}
text.attr.d-removed{fill:${v("--se-del")};text-decoration:line-through}
text.attr.d-changed{fill:${v("--se-chg")}}
.edge.d-added path{stroke:${v("--se-add")};stroke-width:2}
.edge.d-changed path{stroke:${v("--se-chg")};stroke-width:2}
.node.d-removed rect.box{stroke:${v("--se-del")};stroke-width:2.5;stroke-dasharray:6 3}
.node.d-removed text.name{fill:${v("--se-del")};text-decoration:line-through}
.edge.d-removed path{stroke:${v("--se-del")};stroke-width:2;stroke-dasharray:6 3}
.edge.d-added text{fill:${v("--se-add")}}
.edge.d-removed text{fill:${v("--se-del")};text-decoration:line-through}
.edge.d-changed text{fill:${v("--se-chg")}}
${this.extraCss()}`;
  }

  /** Styles of what drawRaw draws, for the export. */
  protected extraCss(): string {
    return "";
  }

  downloadSvg(name: string): void {
    downloadBlob(new Blob([this.exportSvg()], { type: "image/svg+xml" }), `${name}.svg`);
  }

  async downloadPng(name: string, scale = 2): Promise<void> {
    const svg = this.exportSvg();
    const img = new Image();
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("cannot render SVG"));
      img.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(this.content.w * scale);
    canvas.height = Math.ceil(this.content.h * scale);
    const c = canvas.getContext("2d");
    if (!c) return;
    c.fillStyle = this.cssVar("--se-panel");
    c.fillRect(0, 0, canvas.width, canvas.height);
    c.drawImage(img, 0, 0, canvas.width, canvas.height);
    URL.revokeObjectURL(url);
    canvas.toBlob((blob) => blob && downloadBlob(blob, `${name}.png`), "image/png");
  }
}
