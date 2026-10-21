// The content-model tree of a type or element, drawn left to right in the
// style of XML editors: element boxes (dashed when optional, stacked when
// repeated), sequence / choice / all compositors, group references and
// attribute lists. Nodes expand on demand, so deep and recursive models stay cheap.
import { Diagram, MONO, SANS, measure, type DiagramCallbacks, type NodeAction, type View } from "./diagram";
import { s } from "./dom";
import { MARKER, type Compare, type Mark } from "./diff";
import { isId, occursText, type Id, type Model, type Particle, type Ref } from "./model";

/** Compare mode: the diff whose changes the tree marks. */
let diffHook: Compare | null = null;
export function setTreeDiff(c: Compare | null): void {
  diffHook = c;
}

const markLine = (d: Mark | undefined, l: string) => (d ? `${MARKER[d]} ${l}` : l);

/** The child elements removed from what `owner` declares, as nodes to show after its content. */
function removedNodes(owner: Id | undefined, key: string): TNode[] {
  if (!diffHook || owner === undefined) return [];
  return diffHook.childMarks(owner).removed.map((r, i) => {
    const [a, b] = (r.mult ?? "1..1").split("..");
    return { key: `${key}.x${i}`, kind: "element" as const, label: r.name, min: Number(a) || 0, max: b === "*" ? null : Number(b) || 1, diff: "removed" as const, expandable: false, children: () => [] };
  });
}

function withRemoved(n: TNode, owner: Id | undefined): TNode {
  const extra = removedNodes(owner, n.key);
  if (!extra.length) return n;
  const kids = n.children;
  return { ...n, expandable: true, children: () => [...kids(), ...extra] };
}

export interface TNode {
  key: string;
  kind: "element" | "type" | "sequence" | "choice" | "all" | "any" | "group" | "attrs";
  label: string;
  /** Element declaration, group or type behind the node. */
  id?: Id;
  typeName?: string;
  typeId?: Id;
  min: number;
  max: number | null;
  /** Caption above the node (e.g. "from Base"). */
  note?: string;
  lines?: string[];
  expandable: boolean;
  children: () => TNode[];
  /** Compare mode: how it differs from the earlier version. */
  diff?: Mark;
}

const NAME_FONT = `600 13px ${SANS}`;
const TYPE_FONT = `11px ${MONO}`;
const SMALL_FONT = `11px ${SANS}`;
const GAP_X = 34;
const GAP_Y = 14;
const COMP_W = 40;
const COMP_H = 24;

function occ(p: { min?: number; max?: number | null }): { min: number; max: number | null } {
  return { min: p.min ?? 1, max: p.max === undefined ? 1 : p.max };
}

/** Children of something with a complex type: its attributes, then its content. */
function typeChildren(m: Model, typeId: Ref | undefined, key: string): TNode[] {
  if (!isId(typeId) || m.comp(typeId).kind !== "complexType") return [];
  const out: TNode[] = [];
  const attrs = m.attributes(typeId).filter((a) => a.use !== "prohibited");
  if (attrs.length) {
    const lines = attrs.map((a) => {
      const name = isId(a.attr) ? m.comp(a.attr).name ?? "" : m.refName(a.attr);
      const t = m.typeName(m.attrType(a.attr));
      return markLine(diffHook?.childMarks(a.from).attrs.get(name), `@${name}${t ? " : " + t : ""}${a.use === "required" ? "" : " ?"}`);
    });
    if (diffHook) for (const r of diffHook.childMarks(typeId).removedAttrs) lines.push(markLine("removed", `@${r.name}`));
    out.push({ key: `${key}.@`, kind: "attrs", label: `attributes (${attrs.length})`, lines, min: 1, max: 1, expandable: false, children: () => [] });
  }
  const ct = m.comp(typeId).complexType!;
  const parts = (ct.effective?.content ?? (ct.content ? [typeId] : [])).filter((p) => m.comp(p).complexType?.content);
  if (parts.length === 1) {
    out.push(withRemoved(particleNode(m, m.comp(parts[0]).complexType!.content!, `${key}.0`, parts[0] !== typeId ? `from ${m.label(parts[0])}` : undefined, parts[0]), parts[0]));
  } else if (parts.length > 1) {
    // Extension: the base content, then what each derived type adds, in a sequence.
    out.push({
      key: `${key}.0`,
      kind: "sequence",
      label: "sequence",
      min: 1,
      max: 1,
      expandable: true,
      children: () => parts.map((p, i) => withRemoved(particleNode(m, m.comp(p).complexType!.content!, `${key}.0.${i}`, `from ${m.label(p)}`, p), p)),
    });
  }
  return out;
}

export function particleNode(m: Model, p: Particle, key: string, note?: string, owner?: Id): TNode {
  const o = occ(p);
  switch (p.t) {
    case "element": {
      const id = isId(p.el) ? p.el : undefined;
      const t = id !== undefined ? m.elementType(id) : undefined;
      const complex = m.isComplex(t) && (typeChildren(m, t, key).length > 0);
      const label = id !== undefined ? m.comp(id).name ?? "" : m.refName(p.el);
      const diff = diffHook && owner !== undefined ? diffHook.childMarks(owner).children.get(label) : undefined;
      return { key, kind: "element", label, diff, id, typeName: t !== undefined ? m.typeName(t) : undefined, typeId: isId(t) ? t : undefined, ...o, note, expandable: complex, children: () => typeChildren(m, t, key) };
    }
    case "group": {
      const gid = isId(p.group) ? p.group : undefined;
      const gp = gid !== undefined ? m.comp(gid).group : undefined;
      return { key, kind: "group", label: m.refName(p.group), id: gid, ...o, note, expandable: !!gp, children: () => (gp ? [withRemoved(particleNode(m, gp, `${key}.0`, undefined, gid), gid)] : []) };
    }
    case "any":
      return { key, kind: "any", label: "any", typeName: p.namespace ?? "##any", ...o, note, expandable: false, children: () => [] };
    default:
      return { key, kind: p.t, label: p.t, ...o, note, expandable: p.items.length > 0, children: () => p.items.map((it, i) => particleNode(m, it, `${key}.${i}`, undefined, owner)) };
  }
}

/** The root of the tree for a page: an element, a complex type or a group. */
export function rootNode(m: Model, id: Id): TNode {
  const c = m.comp(id);
  if (c.kind === "element") {
    const t = m.elementType(id);
    return { key: "r", kind: "element", label: c.name ?? "", diff: diffHook?.mark(id), id, typeName: t !== undefined ? m.typeName(t) : undefined, typeId: isId(t) ? t : undefined, min: 1, max: 1, expandable: true, children: () => typeChildren(m, t, "r") };
  }
  if (c.kind === "group" && c.group) {
    return { key: "r", kind: "group", label: m.qname(id), diff: diffHook?.mark(id), id, min: 1, max: 1, expandable: true, children: () => [withRemoved(particleNode(m, c.group!, "r.0", undefined, id), id)] };
  }
  return { key: "r", kind: "type", label: m.label(id), diff: diffHook?.mark(id), id, typeId: id, min: 1, max: 1, expandable: true, children: () => typeChildren(m, id, "r") };
}

interface Placed {
  n: TNode;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Width reserved before the children (the box or its caption). */
  span: number;
  kids: Placed[];
  open: boolean;
}

function nodeSize(n: TNode): { w: number; h: number } {
  if (n.kind === "sequence" || n.kind === "choice" || n.kind === "all") return { w: COMP_W, h: COMP_H };
  if (n.kind === "attrs") {
    const lines = n.lines ?? [];
    const w = Math.max(measure(n.label, SMALL_FONT), ...lines.slice(0, 14).map((l) => measure(l, TYPE_FONT))) + 20;
    return { w: Math.min(360, Math.ceil(w)), h: 22 + Math.min(lines.length, 14) * 15 + (lines.length > 14 ? 15 : 0) + 6 };
  }
  const name = shownName(n);
  const w = Math.max(measure(name, NAME_FONT), n.typeName ? measure(n.typeName, TYPE_FONT) : 0) + 24 + (n.expandable ? 10 : 0);
  return { w: Math.min(340, Math.max(70, Math.ceil(w))), h: n.typeName ? 40 : 28 };
}

function shownName(n: TNode): string {
  return markLine(n.diff, n.kind === "group" ? `group ${n.label}` : n.label);
}

/** Compositors open with their parent; elements and groups when asked. */
function isOpen(n: TNode, open: Set<string>): boolean {
  if (!n.expandable) return false;
  if (n.kind === "sequence" || n.kind === "choice" || n.kind === "all" || n.kind === "type") return !open.has("-" + n.key);
  return open.has(n.key) || n.key === "r";
}

function place(n: TNode, x: number, y: number, open: Set<string>, budget: { n: number }): Placed {
  const { w, h } = nodeSize(n);
  const extra = n.note ? 14 : 0;
  const o = isOpen(n, open) && budget.n > 0;
  const span = Math.max(w, n.note ? Math.ceil(measure(n.note, SMALL_FONT)) + 6 : 0);
  const p: Placed = { n, x, y: y + extra, w, h, span, kids: [], open: o };
  budget.n--;
  if (!o) {
    (p as Placed & { total: number }).total = h + extra + (n.min !== 1 || n.max !== 1 ? 12 : 0);
    return p;
  }
  let cy = y;
  for (const c of n.children()) {
    const k = place(c, x + span + GAP_X, cy, open, budget);
    p.kids.push(k);
    cy += (k as Placed & { total: number }).total + GAP_Y;
  }
  const kidsH = Math.max(0, cy - y - GAP_Y);
  const own = h + extra + (n.min !== 1 || n.max !== 1 ? 12 : 0);
  // Centre the node on its children.
  if (kidsH > own) p.y = y + extra + (kidsH - own) / 2;
  (p as Placed & { total: number }).total = Math.max(own, kidsH);
  return p;
}

export interface TreeCallbacks extends DiagramCallbacks {
  onToggle: (n: TNode, open: boolean) => void;
  actions: (n: TNode) => NodeAction[];
}

/** The tree on the diagram canvas (pan, zoom, export come from Diagram). */
export class TreeView extends Diagram {
  private tcb: TreeCallbacks;

  constructor(host: HTMLElement, cb: TreeCallbacks) {
    super(host, cb);
    this.tcb = cb;
    this.svg.classList.add("cm-tree");
  }

  show(root: TNode, open: Set<string>, opts: { keepView?: boolean; view?: View } = {}): number {
    let count = 0;
    this.drawRaw((vp) => {
      const budget = { n: 1500 };
      const laid = place(root, 10, 10, open, budget);
      const edges = s("g", { class: "edges" });
      const nodes = s("g", { class: "nodes" });
      vp.append(edges, nodes);
      let maxX = 0;
      let maxY = 0;
      const draw = (p: Placed) => {
        count++;
        maxX = Math.max(maxX, p.x + p.w + 20);
        maxY = Math.max(maxY, p.y + p.h + 16);
        nodes.appendChild(this.drawTNode(p));
        if (!p.kids.length) return;
        const sx = p.x + p.w + (p.n.expandable ? 8 : 0);
        const sy = p.y + p.h / 2;
        const bx = p.x + p.span + GAP_X / 2;
        const ys = p.kids.map((k) => k.y + k.h / 2);
        edges.appendChild(s("path", { d: `M${sx} ${sy}H${bx}M${bx} ${Math.min(...ys, sy)}V${Math.max(...ys, sy)}` }));
        for (const k of p.kids) {
          edges.appendChild(s("path", { d: `M${bx} ${k.y + k.h / 2}H${k.x}` }));
          draw(k);
        }
      };
      draw(laid);
      return { w: maxX, h: maxY };
    }, opts);
    this.tcb.onStatus?.(`${count} nodes · click a box for options, + to expand`);
    return count;
  }

  private drawTNode(p: Placed): SVGGElement {
    const n = p.n;
    const optional = n.min === 0;
    const many = n.max === null || n.max > 1;
    const g = s("g", { class: `tn ${n.kind}${optional ? " optional" : ""}${n.diff ? ` d-${n.diff}` : ""}`, transform: `translate(${p.x} ${p.y})` });
    if (n.note) g.appendChild(s("text", { class: "note", x: 0, y: -7 }, n.note));
    if (n.kind === "sequence" || n.kind === "choice" || n.kind === "all") {
      g.appendChild(s("rect", { class: "comp", width: p.w, height: p.h, rx: 11 }));
      const cy = p.h / 2;
      if (n.kind === "sequence") {
        g.appendChild(s("path", { class: "glyph", d: `M8 ${cy}H${p.w - 8}` }));
        for (const x of [13, 20, 27]) g.appendChild(s("circle", { class: "dot", cx: x, cy, r: 2.4 }));
      } else if (n.kind === "choice") {
        g.appendChild(s("path", { class: "glyph", d: `M7 ${cy}H14L24 ${cy - 6}M24 ${cy - 6}H33M24 ${cy}H33M24 ${cy + 6}H33` }));
        for (const y of [cy - 6, cy, cy + 6]) g.appendChild(s("circle", { class: "dot", cx: 28, cy: y, r: 1.8 }));
      } else {
        g.appendChild(s("text", { class: "all", x: p.w / 2, y: cy }, "all"));
      }
      g.appendChild(s("title", null, n.kind));
    } else if (n.kind === "attrs") {
      g.appendChild(s("rect", { class: "attrs", width: p.w, height: p.h, rx: 6 }));
      g.appendChild(s("text", { class: "attrs-head", x: 10, y: 12 }, n.label));
      const lines = n.lines ?? [];
      const lineCls = (l: string) => (l.startsWith("+ ") ? " d-added" : l.startsWith("− ") ? " d-removed" : l.startsWith("~ ") ? " d-changed" : "");
      lines.slice(0, 14).forEach((l, i) => g.appendChild(s("text", { class: `attr-line${lineCls(l)}`, x: 10, y: 30 + i * 15 }, l)));
      if (lines.length > 14) g.appendChild(s("text", { class: "attr-line more", x: 10, y: 30 + 14 * 15 }, `+${lines.length - 14} more`));
    } else {
      if (many) g.appendChild(s("rect", { class: "box stack", x: 4, y: 4, width: p.w, height: p.h, rx: 4 }));
      g.appendChild(s("rect", { class: "box", width: p.w, height: p.h, rx: n.kind === "group" ? 10 : 4 }));
      const nameY = n.typeName ? 14 : p.h / 2;
      g.appendChild(s("text", { class: "tname", x: 10, y: nameY }, shownName(n)));
      if (n.typeName) g.appendChild(s("text", { class: "ttype", x: 10, y: 30 }, n.typeName));
    }
    if (n.min !== 1 || n.max !== 1) g.appendChild(s("text", { class: "occ", x: p.w, y: p.h + 10, "text-anchor": "end" }, occursText(n.min, n.max)));
    if (n.expandable && n.kind !== "sequence" && n.kind !== "choice" && n.kind !== "all") {
      const ex = s("g", { class: "expander", transform: `translate(${p.w} ${p.h / 2})` });
      ex.appendChild(s("circle", { r: 7 }));
      ex.appendChild(s("path", { d: p.open ? "M-3.5 0H3.5" : "M-3.5 0H3.5M0 -3.5V3.5" }));
      ex.appendChild(s("title", null, p.open ? "Collapse" : "Expand"));
      ex.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this.tcb.onToggle(n, !p.open);
      });
      g.appendChild(ex);
    } else if (n.expandable) {
      g.addEventListener("dblclick", (ev) => {
        ev.stopPropagation();
        this.tcb.onToggle(n, !p.open);
      });
    }
    g.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const actions = this.tcb.actions(n);
      if (actions.length) this.showMenu(n.kind === "group" ? `group ${n.label}` : n.label, actions, ev.clientX, ev.clientY);
    });
    if (n.kind === "element" && n.expandable) {
      g.addEventListener("dblclick", (ev) => {
        ev.stopPropagation();
        this.tcb.onToggle(n, !p.open);
      });
    }
    return g;
  }

  /** Trees are read at a readable size from the top left, not shrunk to fit. */
  fit(): void {
    const box = this.svg.getBoundingClientRect();
    if (!box.width || !this.content.w) return;
    const top = 52;
    const s = Math.min((box.width - 24) / this.content.w, (box.height - top - 30) / this.content.h);
    this.scale = Math.min(1.1, Math.max(0.75, s));
    this.tx = Math.max(12, (box.width - this.content.w * this.scale) / 2);
    this.ty = top + Math.max(0, (box.height - top - 30 - this.content.h * this.scale) / 2);
    this.applyTransform(false);
    this.cb.onViewChange?.(null);
  }

  protected extraCss(): string {
    const v = (n: string) => this.cssVar(n);
    return `
.edges path{fill:none;stroke:${v("--se-border-strong")};stroke-width:1.2}
.tn rect.box{fill:${v("--se-panel")};stroke:${v("--se-class")};stroke-width:1.4}
.tnode.optional rect.box,.tnode.optional rect.comp{stroke-dasharray:4 3}
.tn rect.stack{fill:${v("--se-panel")}}
.tnode.group rect.box{stroke:${v("--se-shape")}}
.tnode.any rect.box{stroke:${v("--se-border-strong")}}
.tn rect.comp{fill:${v("--se-panel-2")};stroke:${v("--se-border-strong")};stroke-width:1.2}
.tn .glyph{stroke:${v("--se-text-2")};stroke-width:1.4;fill:none}
.tn .dot{fill:${v("--se-text")}}
.tn rect.attrs{fill:${v("--se-panel-2")};stroke:${v("--se-border")}}
.tn text{font-family:Barlow,system-ui,sans-serif;dominant-baseline:middle;fill:${v("--se-text")}}
.tn text.tname{font-weight:600;font-size:13px}
.tn text.ttype,.tn text.attr-line{font-family:"JetBrains Mono",ui-monospace,monospace;font-size:11px;fill:${v("--se-text-2")}}
.tn text.attrs-head,.tn text.note,.tn text.occ,.tn text.all{font-size:11px;fill:${v("--se-text-2")}}
.tn text.all{text-anchor:middle}
.tn .expander circle{fill:${v("--se-panel")};stroke:${v("--se-class")}}
.tn .expander path{stroke:${v("--se-class")};stroke-width:1.5}
.tn.d-added rect.box{stroke:${v("--se-add")};stroke-width:2.2;fill:${v("--se-add-bg")}}
.tn.d-changed rect.box{stroke:${v("--se-chg")};stroke-width:2.2;fill:${v("--se-chg-bg")}}
.tn.d-removed rect.box{stroke:${v("--se-del")};stroke-dasharray:4 3;fill:${v("--se-del-bg")}}
.tn.d-removed text.tname{text-decoration:line-through;fill:${v("--se-del")}}
.tn text.attr-line.d-added{fill:${v("--se-add")}}
.tn text.attr-line.d-changed{fill:${v("--se-chg")}}
.tn text.attr-line.d-removed{fill:${v("--se-del")};text-decoration:line-through}
`;
  }
}
