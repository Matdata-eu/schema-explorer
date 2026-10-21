// Builds the graph a diagram shows: UML-like boxes for complex types, with
// generalisation (extension, restriction), composition for child elements and
// «enumeration» boxes for enumerated simple types.
import { isId, occursText, type ContentRow, type Id, type Model, type Ref } from "./model";

export type NodeKind = "class" | "enum" | "element" | "more";

export interface AttrLine {
  text: string;
  type?: string;
  mult?: string;
  inherited?: boolean;
  /** Header shown above the line when it changes (e.g. "choice"). */
  group?: string;
  groupKey?: string;
  /** Component to open on click. */
  id?: Id;
  /** Compare mode: how the line differs from the earlier version. */
  diff?: "added" | "removed" | "changed";
}

export interface NodeSpec {
  key: string;
  id?: Id;
  kind: NodeKind;
  name: string;
  stereotype?: string;
  abstract?: boolean;
  external?: boolean;
  focus?: boolean;
  attrs: AttrLine[];
  /** Lines not shown (collapsed). */
  hiddenAttrs: number;
  moreOf?: { from: string; relation: string; ids: Id[] };
  diff?: "added" | "removed" | "changed";
}

export type EdgeKind = "gen" | "restr" | "comp" | "dep" | "incoming" | "typed";

export interface EdgeSpec {
  key: string;
  from: string;
  to: string;
  kind: EdgeKind;
  label?: string;
  mult?: string;
  /** Component behind the edge, for navigation. */
  id?: Id;
  diff?: "added" | "removed" | "changed";
}

export interface GraphSpec {
  nodes: NodeSpec[];
  edges: EdgeSpec[];
  /** Nodes left out because of the cap. */
  omitted: number;
}

export interface NeighborhoodOptions {
  focus: Id;
  depth: 1 | 2;
  inherited: boolean;
  incoming: boolean;
  derived: boolean;
  enums: boolean;
  maxNeighbors: number;
  maxAttrs: number;
  expanded: Set<Id>;
  openAttrs: Set<Id>;
}

export const defaultNeighborhood = (focus: Id): NeighborhoodOptions => ({
  focus,
  depth: 1,
  inherited: false,
  incoming: true,
  derived: true,
  enums: true,
  maxNeighbors: 30,
  maxAttrs: 16,
  expanded: new Set(),
  openAttrs: new Set(),
});

const mult = (min: number, max: number | null) => occursText(min, max);

/** The type of an element row: its declared type (named or anonymous). */
export function rowType(m: Model, r: ContentRow): Ref | undefined {
  return r.id !== undefined ? m.elementType(r.id) : undefined;
}

/** Lines inside a type's box: attributes, simple content and simple-typed child elements. */
function lines(m: Model, tid: Id, inherited: boolean): AttrLine[] {
  const out: AttrLine[] = [];
  const c = m.comp(tid);
  for (const a of m.attributes(tid)) {
    if (!inherited && a.from !== tid) continue;
    if (a.use === "prohibited") continue;
    const t = m.attrType(a.attr);
    out.push({ text: "@" + (isId(a.attr) ? m.comp(a.attr).name ?? "" : m.refName(a.attr)), type: m.typeName(t), mult: a.use === "required" ? "1" : "0..1", inherited: a.from !== tid, id: isId(a.attr) ? a.attr : undefined });
  }
  const simple = c.complexType?.effective?.simple ?? (c.complexType?.derivation?.simple ? c.complexType.derivation.base : undefined);
  if (simple !== undefined) out.push({ text: "(value)", type: m.typeName(simple), id: isId(simple) ? simple : undefined });
  let n = 0;
  let key = "";
  for (const r of m.contentRows(tid, { inherited })) {
    if (r.kind === "compositor" && r.compositor !== "sequence") key = `${r.compositor}${++n}`;
    else if (r.kind === "compositor" && r.depth === 0) key = "";
    if (r.kind === "any") {
      out.push({ text: "any", type: r.wildcard?.namespace ?? "##any", mult: mult(r.min, r.max), inherited: r.from !== tid, group: r.inChoice ? "choice" : undefined, groupKey: r.inChoice ? key : undefined });
      continue;
    }
    if (r.kind !== "element") continue;
    const t = rowType(m, r);
    if (m.isComplex(t)) continue; // drawn as an arrow
    const name = r.id !== undefined ? m.comp(r.id).name ?? "" : m.refName(r.missing);
    out.push({ text: name, type: m.typeName(t), mult: mult(r.min, r.max), inherited: r.from !== tid, group: r.inChoice ? "choice" : undefined, groupKey: r.inChoice ? key : undefined, id: r.id });
  }
  return out;
}

function stereo(m: Model, id: Id): string | undefined {
  const c = m.comp(id);
  const s: string[] = [];
  if (c.complexType?.abstract) s.push("abstract");
  if (!c.name) s.push("anonymous");
  if (c.complexType?.mixed) s.push("mixed");
  return s.length ? `«${s.join(", ")}»` : undefined;
}

export function typeNode(m: Model, id: Id, o: { focus?: boolean; attrs: boolean; inherited: boolean; open: boolean; cap: number }): NodeSpec {
  const c = m.comp(id);
  const all = o.attrs ? lines(m, id, o.inherited) : [];
  const shown = o.open || all.length <= o.cap ? all : all.slice(0, o.cap);
  return {
    key: `c${id}`,
    id,
    kind: "class",
    name: c.name ? c.name : m.label(id),
    stereotype: stereo(m, id),
    abstract: c.complexType?.abstract,
    external: c.builtin,
    focus: o.focus,
    attrs: shown,
    hiddenAttrs: all.length - shown.length,
  };
}

export function enumNode(m: Model, id: Id, cap = 10): NodeSpec {
  const values = m.enumerations(id);
  return {
    key: `e${id}`,
    id,
    kind: "enum",
    name: m.label(id),
    stereotype: "«enumeration»",
    attrs: values.slice(0, cap).map((v) => ({ text: v.value })),
    hiddenAttrs: Math.max(0, values.length - cap),
  };
}

/** The neighbourhood of a complex type. */
export function buildNeighborhood(m: Model, o: NeighborhoodOptions): GraphSpec {
  const nodes = new Map<string, NodeSpec>();
  const edges = new Map<string, EdgeSpec>();
  let omitted = 0;
  let budget = o.maxNeighbors;
  const take = (key: string, make: () => NodeSpec, force = false): boolean => {
    if (nodes.has(key)) return true;
    if (!force && budget <= 0) {
      omitted++;
      return false;
    }
    if (!force) budget--;
    nodes.set(key, make());
    return true;
  };
  const addType = (id: Id, focus = false) =>
    take(`c${id}`, () => typeNode(m, id, { focus, attrs: focus || o.expanded.has(id), inherited: focus && o.inherited, open: o.openAttrs.has(id), cap: focus ? o.maxAttrs * 2 : o.maxAttrs }), focus);
  const edge = (e: EdgeSpec) => {
    if (!edges.has(e.key)) edges.set(e.key, e);
  };

  const walk = (tid: Id, isFocus: boolean, level: number) => {
    const c = m.comp(tid);
    const ct = c.complexType;
    if (!ct) return;
    const inh = isFocus && o.inherited;
    // Base type.
    const base = ct.derivation?.base;
    if (m.isComplex(base) && addType(base)) edge({ key: `g${base}-${tid}`, from: `c${base}`, to: `c${tid}`, kind: ct.derivation!.method === "restriction" ? "restr" : "gen", label: ct.derivation!.method === "restriction" ? "«restriction»" : undefined });
    // Derived types.
    if (o.derived && (isFocus || o.expanded.has(tid))) {
      for (const d of m.derived(tid)) {
        if (!m.isComplex(d)) continue;
        const r = m.comp(d).complexType?.derivation?.method === "restriction";
        if (addType(d)) edge({ key: `g${tid}-${d}`, from: `c${tid}`, to: `c${d}`, kind: r ? "restr" : "gen", label: r ? "«restriction»" : undefined });
      }
    }
    // Child elements of a complex type: composition.
    for (const r of m.contentRows(tid, { inherited: inh })) {
      if (r.kind !== "element" || r.id === undefined) continue;
      const t = rowType(m, r);
      const name = m.comp(r.id).name ?? "";
      if (m.isComplex(t)) {
        if (addType(t)) edge({ key: `a${tid}-${r.id}-${t}`, from: `c${tid}`, to: `c${t}`, kind: "comp", label: r.inChoice ? `${name} ⊕` : name, mult: mult(r.min, r.max), id: r.id });
      } else if (o.enums && isId(t) && m.isEnum(t) && (isFocus || o.expanded.has(tid) || level < o.depth)) {
        if (take(`e${t}`, () => enumNode(m, t))) edge({ key: `d${tid}-${t}`, from: `c${tid}`, to: `e${t}`, kind: "dep" });
      }
    }
    // Enumerated attribute types.
    if (o.enums && (isFocus || o.expanded.has(tid) || level < o.depth)) {
      for (const a of m.attributes(tid)) {
        if (!inh && a.from !== tid) continue;
        const t = m.attrType(a.attr);
        if (isId(t) && m.isEnum(t) && take(`e${t}`, () => enumNode(m, t))) edge({ key: `d${tid}-${t}`, from: `c${tid}`, to: `e${t}`, kind: "dep" });
      }
    }
    // Who uses this type: containing types (composition) and global elements.
    if (o.incoming && (isFocus || o.expanded.has(tid))) {
      for (const u of m.usedBy(tid)) {
        if (u.how !== "type") continue;
        const by = m.comp(u.by);
        if (by.kind !== "element") continue;
        if (by.parent === undefined) {
          if (take(`x${u.by}`, () => ({ key: `x${u.by}`, id: u.by, kind: "element", name: by.name ?? "", stereotype: by.element?.abstract ? "«element, abstract»" : "«element»", attrs: [], hiddenAttrs: 0 }))) edge({ key: `t${u.by}-${tid}`, from: `x${u.by}`, to: `c${tid}`, kind: "typed" });
          continue;
        }
        const holder = containingType(m, u.by);
        if (holder === undefined || holder === tid) continue;
        if (addType(holder)) edge({ key: `a${holder}-${u.by}-${tid}`, from: `c${holder}`, to: `c${tid}`, kind: "comp", label: by.name ?? "", id: u.by });
      }
    }
  };

  addType(o.focus, true);
  walk(o.focus, true, 1);
  for (const x of o.expanded) if (x !== o.focus && m.isComplex(x) && addType(x)) walk(x, false, 1);
  if (o.depth >= 2) {
    for (const n of [...nodes.values()]) if (n.kind === "class" && !n.focus && n.id !== undefined) walk(n.id, false, 2);
  }
  // Generalisations between boxes that are there anyway.
  for (const n of [...nodes.values()]) {
    if (n.kind !== "class" || n.id === undefined) continue;
    const d = m.comp(n.id).complexType?.derivation;
    if (d && isId(d.base) && nodes.has(`c${d.base}`)) edge({ key: `g${d.base}-${n.id}`, from: `c${d.base}`, to: `c${n.id}`, kind: d.method === "restriction" ? "restr" : "gen", label: d.method === "restriction" ? "«restriction»" : undefined });
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()], omitted };
}

/** The complex type (named or anonymous) a local declaration sits in. */
export function containingType(m: Model, id: Id): Id | undefined {
  let cur = m.comp(id).parent;
  const seen = new Set<Id>();
  while (cur !== undefined && !seen.has(cur)) {
    seen.add(cur);
    if (m.comp(cur).kind === "complexType") return cur;
    cur = m.comp(cur).parent;
  }
  return undefined;
}

/** A simple type with its base and derived types and the types that use it. */
export function buildSimpleGraph(m: Model, sid: Id, max = 30): GraphSpec {
  const nodes = new Map<string, NodeSpec>();
  const edges: EdgeSpec[] = [];
  let omitted = 0;
  const st = (id: Id, focus = false): NodeSpec => {
    const c = m.comp(id);
    if (m.isEnum(id)) return { ...enumNode(m, id, focus ? 30 : 8), focus };
    const facets = (c.simpleType?.facets ?? []).map((f) => ({ text: f.kind, type: f.value }));
    const v = c.simpleType?.variety;
    return { key: `e${id}`, id, kind: "enum", name: m.label(id), stereotype: v === "list" ? "«list»" : v === "union" ? "«union»" : "«simple type»", attrs: facets.slice(0, 8), hiddenAttrs: Math.max(0, facets.length - 8), focus, external: c.builtin };
  };
  const add = (key: string, make: () => NodeSpec) => {
    if (nodes.has(key)) return true;
    if (nodes.size >= max) {
      omitted++;
      return false;
    }
    nodes.set(key, make());
    return true;
  };
  add(`e${sid}`, () => st(sid, true));
  const c = m.comp(sid).simpleType;
  const base = c?.base;
  if (isId(base) && add(`e${base}`, () => st(base))) edges.push({ key: `g${base}`, from: `e${base}`, to: `e${sid}`, kind: "restr", label: "«restriction»" });
  const item = c?.item;
  if (isId(item) && add(`e${item}`, () => st(item))) edges.push({ key: `i${item}`, from: `e${sid}`, to: `e${item}`, kind: "dep", label: "item" });
  for (const mb of c?.members ?? []) if (isId(mb) && add(`e${mb}`, () => st(mb))) edges.push({ key: `u${mb}`, from: `e${sid}`, to: `e${mb}`, kind: "dep", label: "member" });
  for (const d of m.derived(sid)) if (add(`e${d}`, () => st(d))) edges.push({ key: `g${sid}-${d}`, from: `e${sid}`, to: `e${d}`, kind: "restr" });
  for (const u of m.usedBy(sid)) {
    if (u.how !== "type") continue;
    const holder = m.comp(u.by).kind === "attribute" || m.comp(u.by).kind === "element" ? containingType(m, u.by) : undefined;
    if (holder === undefined) continue;
    if (add(`c${holder}`, () => typeNode(m, holder, { attrs: false, inherited: false, open: false, cap: 0 }))) edges.push({ key: `d${holder}-${u.by}`, from: `c${holder}`, to: `e${sid}`, kind: "dep", label: m.comp(u.by).kind === "attribute" ? "@" + (m.comp(u.by).name ?? "") : m.comp(u.by).name, id: u.by });
  }
  return { nodes: [...nodes.values()], edges: dedupe(edges), omitted };
}

function dedupe(edges: EdgeSpec[]): EdgeSpec[] {
  const seen = new Set<string>();
  return edges.filter((e) => !seen.has(e.key) && !!seen.add(e.key));
}

export interface OverviewOptions {
  ns?: number;
  folder?: string;
  associations: boolean;
  maxNodes: number;
}

/** Top-level folders of the files, for narrowing the map. */
export function folders(m: Model): { folder: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const id of m.lists.complexType) {
    const f = m.fileName(id);
    if (!f) continue;
    const i = f.lastIndexOf("/");
    const dir = i < 0 ? "." : f.slice(0, i);
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  return [...counts.entries()].map(([folder, count]) => ({ folder, count })).sort((a, b) => a.folder.localeCompare(b.folder));
}

export function buildOverview(m: Model, o: OverviewOptions): GraphSpec {
  let ids = m.lists.complexType.filter((id) => {
    const c = m.comp(id);
    if (o.ns !== undefined && c.ns !== o.ns) return false;
    if (o.folder) {
      const f = m.fileName(id) ?? "";
      const dir = f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : ".";
      if (dir !== o.folder && !dir.startsWith(o.folder + "/")) return false;
    }
    return true;
  });
  const total = ids.length;
  if (ids.length > o.maxNodes) {
    const score = (id: Id) => (m.derived(id).length * 3 + (m.comp(id).usedBy?.length ?? 0) + (m.comp(id).complexType?.derivation ? 1 : 0));
    ids = [...ids].sort((a, b) => score(b) - score(a)).slice(0, o.maxNodes);
  }
  const keep = new Set(ids);
  const nodes: NodeSpec[] = ids.map((id) => ({ key: `c${id}`, id, kind: "class", name: m.comp(id).name ?? "", abstract: m.comp(id).complexType?.abstract, attrs: [], hiddenAttrs: 0 }));
  const edges: EdgeSpec[] = [];
  for (const id of ids) {
    const d = m.comp(id).complexType?.derivation;
    if (d && isId(d.base) && keep.has(d.base)) edges.push({ key: `g${d.base}-${id}`, from: `c${d.base}`, to: `c${id}`, kind: d.method === "restriction" ? "restr" : "gen" });
    if (o.associations) {
      const seen = new Set<Id>();
      for (const r of m.contentRows(id, { inherited: false })) {
        if (r.kind !== "element") continue;
        const t = rowType(m, r);
        if (!isId(t) || !keep.has(t) || t === id || seen.has(t)) continue;
        seen.add(t);
        edges.push({ key: `a${id}-${t}`, from: `c${id}`, to: `c${t}`, kind: "comp" });
      }
    }
  }
  return { nodes, edges, omitted: total - ids.length };
}

// ---- text exports ---------------------------------------------------------

function safeId(key: string): string {
  return key.replace(/[^A-Za-z0-9_]/g, "_");
}

export function toPlantUml(g: GraphSpec): string {
  const out: string[] = ["@startuml", "hide empty members", "skinparam classAttributeIconSize 0"];
  for (const n of g.nodes) {
    if (n.kind === "more") continue;
    const id = safeId(n.key);
    const kw = n.kind === "enum" ? "enum" : n.abstract ? "abstract class" : "class";
    const st = n.kind === "element" ? " <<element>>" : "";
    if (n.attrs.length === 0) out.push(`${kw} "${n.name}" as ${id}${st}`);
    else {
      out.push(`${kw} "${n.name}" as ${id}${st} {`);
      let group: string | undefined;
      for (const a of n.attrs) {
        if (a.groupKey !== group) {
          group = a.groupKey;
          if (a.group) out.push(`  .. ${a.group} ..`);
        }
        out.push(`  ${a.text}${a.type ? " : " + a.type : ""}${a.mult ? " [" + a.mult + "]" : ""}`);
      }
      if (n.hiddenAttrs) out.push(`  .. ${n.hiddenAttrs} more ..`);
      out.push("}");
    }
  }
  for (const e of g.edges) {
    const a = safeId(e.from);
    const b = safeId(e.to);
    const lbl = e.label ? ` : ${e.label}` : "";
    switch (e.kind) {
      case "gen":
        out.push(`${a} <|-- ${b}`);
        break;
      case "restr":
        out.push(`${a} <|.. ${b} : restriction`);
        break;
      case "comp":
        out.push(`${a} *--> ${e.mult ? `"${e.mult}" ` : ""}${b}${lbl}`);
        break;
      default:
        out.push(`${a} ..> ${b}${lbl}`);
    }
  }
  out.push("@enduml");
  return out.join("\n");
}

export function toMermaid(g: GraphSpec): string {
  const out: string[] = ["classDiagram"];
  const q = (s: string) => s.replace(/[`"]/g, "'");
  for (const n of g.nodes) {
    if (n.kind === "more") continue;
    const id = safeId(n.key);
    out.push(`  class ${id}["${q(n.name)}"]`);
    if (n.kind === "enum") out.push(`  <<enumeration>> ${id}`);
    else if (n.kind === "element") out.push(`  <<element>> ${id}`);
    else if (n.abstract) out.push(`  <<abstract>> ${id}`);
    for (const a of n.attrs) {
      const type = a.type ? a.type.replace(/[^A-Za-z0-9_:]/g, "_") : "";
      out.push(`  ${id} : ${type ? type + " " : ""}${q(a.text).replace(/[^A-Za-z0-9_@ ]/g, "_")}${a.mult ? " [" + a.mult.replace(/\.\./g, "_") + "]" : ""}`);
    }
    if (n.hiddenAttrs) out.push(`  ${id} : ... ${n.hiddenAttrs} more`);
  }
  for (const e of g.edges) {
    const a = safeId(e.from);
    const b = safeId(e.to);
    const lbl = e.label ? ` : ${q(e.label).replace(/[«»⊕]/g, "")}${e.mult ? " " + e.mult : ""}` : "";
    switch (e.kind) {
      case "gen":
        out.push(`  ${a} <|-- ${b}`);
        break;
      case "restr":
        out.push(`  ${a} <|.. ${b}`);
        break;
      case "comp":
        out.push(`  ${a} *-- ${b}${lbl}`);
        break;
      default:
        out.push(`  ${a} ..> ${b}${lbl}`);
    }
  }
  return out.join("\n");
}
