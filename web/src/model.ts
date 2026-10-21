// The bundle written by the Rust core (format 1) and a Model with the lookups
// the views need. See crates/core/src/bundle.rs for the authoritative types.

export type Id = number;

export type Kind = "element" | "complexType" | "simpleType" | "attribute" | "attributeGroup" | "group" | "key" | "keyref" | "unique";

/** A component id, or `{ns}local` when the reference could not be resolved. */
export type Ref = Id | string;

export interface Doc {
  lang?: string;
  source?: string;
  text: string;
}

export interface Occurs {
  min?: number;
  /** Absent: 1; null: unbounded. */
  max?: number | null;
}

export interface Wildcard {
  namespace?: string;
  notNamespace?: string;
  processContents?: string;
}

export type Particle =
  | ({ t: "element"; el: Ref } & Occurs)
  | ({ t: "group"; group: Ref } & Occurs)
  | ({ t: "sequence" | "choice" | "all"; items: Particle[] } & Occurs)
  | ({ t: "any" } & Wildcard & Occurs);

export type AttrUse = "optional" | "required" | "prohibited";

export type AttrItem = { t: "attribute"; attr: Ref; use?: AttrUse; default?: string; fixed?: string } | { t: "group"; group: Ref };

export interface Facet {
  kind: string;
  value: string;
  fixed?: boolean;
}

export interface Enumeration {
  value: string;
  docs?: Doc[];
  appinfo?: string[];
  line?: number;
}

export interface EffectiveAttr {
  attr: Ref;
  use?: AttrUse;
  default?: string;
  fixed?: string;
  from: Id;
  via?: Id;
}

export interface Effective {
  content?: Id[];
  attributes?: EffectiveAttr[];
  anyAttribute?: Wildcard;
  simple?: Ref;
  mixed?: boolean;
}

export interface ComplexInfo {
  derivation?: { method: "extension" | "restriction"; base: Ref; simple?: boolean };
  content?: Particle;
  attributes?: AttrItem[];
  anyAttribute?: Wildcard;
  facets?: Facet[];
  enumerations?: Enumeration[];
  mixed?: boolean;
  abstract?: boolean;
  final?: string;
  block?: string;
  asserts?: string[];
  derived?: Id[];
  effective?: Effective;
}

export interface SimpleInfo {
  variety: "atomic" | "list" | "union";
  base?: Ref;
  item?: Ref;
  members?: Ref[];
  facets?: Facet[];
  enumerations?: Enumeration[];
  final?: string;
  derived?: Id[];
}

export interface ElementInfo {
  type?: Ref;
  substitutionGroup?: Ref[];
  members?: Id[];
  abstract?: boolean;
  nillable?: boolean;
  default?: string;
  fixed?: string;
  final?: string;
  block?: string;
  identity?: Id[];
}

export interface AttributeInfo {
  type?: Ref;
  default?: string;
  fixed?: string;
  inheritable?: boolean;
}

export type UseKind = "type" | "base" | "item" | "member" | "element" | "attribute" | "group" | "attributeGroup" | "substitution" | "refer";

export interface Usage {
  by: Id;
  how: UseKind;
}

export interface Component {
  kind: Kind;
  name?: string;
  ns?: number;
  parent?: Id;
  file?: number;
  line?: number;
  docs?: Doc[];
  appinfo?: string[];
  redefines?: Id;
  usedBy?: Usage[];
  element?: ElementInfo;
  complexType?: ComplexInfo;
  simpleType?: SimpleInfo;
  attribute?: AttributeInfo;
  group?: Particle;
  attributeGroup?: { attributes?: AttrItem[]; anyAttribute?: Wildcard };
  identity?: { selector: string; fields: string[]; refer?: Ref };
  builtin?: boolean;
}

export interface Directive {
  kind: "import" | "include" | "redefine" | "override";
  namespace?: string;
  location?: string;
  file?: number;
  via?: string;
  line: number;
}

export interface FileInfo {
  name: string;
  targetNamespace?: string;
  namespace?: number;
  prefixes?: Record<string, string>;
  version?: string;
  elementFormQualified?: boolean;
  attributeFormQualified?: boolean;
  input?: boolean;
  directives?: Directive[];
  docs?: Doc[];
  components: number;
}

export interface Diagnostic {
  level: "info" | "warning" | "error";
  code: string;
  message: string;
  file?: number;
  line?: number;
}

export interface Bundle {
  format: number;
  generator: string;
  compact?: boolean;
  files: FileInfo[];
  namespaces: { uri: string; prefix: string }[];
  components: Component[];
  diagnostics?: Diagnostic[];
  stats: {
    files: number;
    global: Partial<Record<Kind, number>>;
    local: Partial<Record<Kind, number>>;
    enumerations: number;
    unresolvedImports: number;
    unresolvedRefs: number;
  };
  search?: Record<string, Id[]>;
  /** Added by the viewer: a title for the top bar. */
  title?: string;
}

export const KIND_LABEL: Record<Kind, string> = {
  element: "Element",
  complexType: "Complex type",
  simpleType: "Simple type",
  attribute: "Attribute",
  attributeGroup: "Attribute group",
  group: "Group",
  key: "Key",
  keyref: "Key reference",
  unique: "Unique",
};

/** Short kind names used in links (#/ct/prefix:Name). */
export const KIND_SLUG: Record<Kind, string> = {
  element: "el",
  complexType: "ct",
  simpleType: "st",
  attribute: "at",
  attributeGroup: "ag",
  group: "gr",
  key: "key",
  keyref: "keyref",
  unique: "unique",
};

export const isId = (r: Ref | undefined): r is Id => typeof r === "number";

/** A row of the content model table: a compositor, an element or a wildcard. */
export interface ContentRow {
  kind: "compositor" | "element" | "any" | "group";
  depth: number;
  /** sequence | choice | all for compositors. */
  compositor?: "sequence" | "choice" | "all";
  /** The element declaration (local or global) or the group. */
  id?: Id;
  /** Unresolved reference text. */
  missing?: string;
  min: number;
  max: number | null;
  /** The type whose own content the row comes from. */
  from: Id;
  /** Directly inside a choice. */
  inChoice: boolean;
  wildcard?: Wildcard;
}

export interface SearchHit {
  id: Id;
  score: number;
}

const XS = "http://www.w3.org/2001/XMLSchema";

export class Model {
  readonly b: Bundle;
  readonly c: Component[];
  /** Global, non built-in components per kind, sorted by name. */
  readonly lists: Record<"complexType" | "simpleType" | "element" | "group" | "attributeGroup" | "attribute", Id[]>;
  private byQname = new Map<string, Id>();
  private lowerNames: string[];
  private searchKeys: string[] | null = null;
  readonly xsNs: number | undefined;

  constructor(b: Bundle) {
    this.b = b;
    this.c = b.components;
    this.xsNs = b.namespaces.findIndex((n) => n.uri === XS);
    if (this.xsNs < 0) this.xsNs = undefined;
    const lists: Model["lists"] = { complexType: [], simpleType: [], element: [], group: [], attributeGroup: [], attribute: [] };
    this.lowerNames = new Array(this.c.length);
    for (let i = 0; i < this.c.length; i++) {
      const c = this.c[i];
      this.lowerNames[i] = (c.name ?? "").toLowerCase();
      if (c.parent !== undefined) continue;
      this.byQname.set(`${KIND_SLUG[c.kind]}/${this.qname(i)}`, i);
      if (c.builtin) continue;
      const l = (lists as Record<string, Id[]>)[c.kind];
      if (l) l.push(i);
    }
    const cmp = (a: Id, z: Id) => {
      const x = this.c[a].name ?? "";
      const y = this.c[z].name ?? "";
      return x < y ? -1 : x > y ? 1 : (this.c[a].ns ?? -1) - (this.c[z].ns ?? -1);
    };
    for (const l of Object.values(lists)) l.sort(cmp);
    this.lists = lists;
  }

  get title(): string {
    if (this.b.title) return this.b.title;
    const input = this.b.files.find((f) => f.input);
    return input ? input.name.split("/").pop()! : "XML Schema";
  }

  comp(id: Id): Component {
    return this.c[id];
  }

  prefix(ns: number | undefined): string {
    return ns === undefined ? "" : this.b.namespaces[ns]?.prefix ?? "";
  }

  /** `prefix:name` of a global component, the bare name of a local one. */
  qname(id: Id): string {
    const c = this.c[id];
    if (c.parent !== undefined) return c.name ?? "";
    const p = this.prefix(c.ns);
    return p ? `${p}:${c.name ?? ""}` : c.name ?? "";
  }

  /** Name for display: anonymous types are named after their element. */
  label(id: Id): string {
    const c = this.c[id];
    if (c.name) return c.name;
    if (c.parent !== undefined) return `${this.label(c.parent)} (anonymous)`;
    return "(anonymous)";
  }

  /** The text of a reference (resolved or not). */
  refName(r: Ref | undefined): string {
    if (r === undefined) return "";
    if (isId(r)) return this.qname(r);
    // {ns}local → local with a prefix when known
    const m = /^\{([^}]*)\}(.*)$/.exec(r);
    if (!m) return r;
    const ns = this.b.namespaces.findIndex((n) => n.uri === m[1]);
    return ns >= 0 ? `${this.prefix(ns)}:${m[2]}` : m[2];
  }

  /** Short type name for diagrams: no xs: prefix on built-ins. */
  typeName(r: Ref | undefined): string {
    if (r === undefined) return "";
    if (isId(r)) {
      const c = this.c[r];
      if (c.builtin || (c.ns !== undefined && c.ns === this.xsNs)) return c.name ?? "";
      if (!c.name) return "(anonymous)";
      return c.name;
    }
    return this.refName(r);
  }

  find(slug: string, qname: string): Id | undefined {
    return this.byQname.get(`${slug}/${qname}`);
  }

  /** The global component a local one is declared in. */
  owner(id: Id): Id {
    let cur = id;
    const seen = new Set<Id>();
    while (this.c[cur].parent !== undefined && !seen.has(cur)) {
      seen.add(cur);
      cur = this.c[cur].parent!;
    }
    return cur;
  }

  isGlobal(id: Id): boolean {
    return this.c[id].parent === undefined;
  }

  docText(id: Id): string {
    return docsText(this.c[id].docs);
  }

  fileName(id: Id): string | undefined {
    const f = this.c[id].file;
    return f === undefined ? undefined : this.b.files[f]?.name;
  }

  /** The element's declared type, through a reference to a global element. */
  elementType(id: Id): Ref | undefined {
    const e = this.c[id].element;
    if (!e) return undefined;
    if (e.type !== undefined) return e.type;
    // No type: that of the substitution group head.
    const head = e.substitutionGroup?.[0];
    if (isId(head) && head !== id) return this.elementType(head);
    return undefined;
  }

  isComplex(r: Ref | undefined): r is Id {
    return isId(r) && this.c[r].kind === "complexType" && !this.c[r].builtin;
  }

  /** Base types from the type itself up to the root. */
  baseChain(id: Id): Ref[] {
    const out: Ref[] = [];
    const seen = new Set<Id>([id]);
    let cur: Ref | undefined = this.baseOf(id);
    while (cur !== undefined) {
      out.push(cur);
      if (!isId(cur) || seen.has(cur)) break;
      seen.add(cur);
      cur = this.baseOf(cur);
    }
    return out;
  }

  baseOf(id: Id): Ref | undefined {
    const c = this.c[id];
    return c.complexType?.derivation?.base ?? c.simpleType?.base;
  }

  derived(id: Id): Id[] {
    const c = this.c[id];
    return c.complexType?.derived ?? c.simpleType?.derived ?? [];
  }

  enumerations(id: Id): Enumeration[] {
    const c = this.c[id];
    return c.simpleType?.enumerations ?? c.complexType?.enumerations ?? [];
  }

  /** An enumeration simple type (directly or by restricting one). */
  isEnum(id: Id): boolean {
    return this.c[id].kind === "simpleType" && (this.c[id].simpleType?.enumerations?.length ?? 0) > 0;
  }

  /** The content model as table rows, base types first. */
  contentRows(typeId: Id, opts: { inherited: boolean } = { inherited: true }): ContentRow[] {
    const c = this.c[typeId];
    const ct = c.complexType;
    if (!ct) return [];
    const parts = ct.effective?.content ?? (ct.content ? [typeId] : []);
    const rows: ContentRow[] = [];
    for (const from of parts) {
      if (!opts.inherited && from !== typeId) continue;
      const p = this.c[from].complexType?.content;
      if (p) this.particleRows(p, from, 0, false, rows, new Set());
    }
    return rows;
  }

  particleRows(p: Particle, from: Id, depth: number, inChoice: boolean, out: ContentRow[], groups: Set<Id>): void {
    const min = p.min ?? 1;
    const max = p.max === undefined ? 1 : p.max;
    switch (p.t) {
      case "element":
        out.push({ kind: "element", depth, id: isId(p.el) ? p.el : undefined, missing: isId(p.el) ? undefined : p.el, min, max, from, inChoice });
        break;
      case "any":
        out.push({ kind: "any", depth, min, max, from, inChoice, wildcard: p });
        break;
      case "group": {
        // A group reference is shown expanded, with its name on the compositor row.
        const gid = isId(p.group) ? p.group : undefined;
        const gp = gid !== undefined ? this.c[gid].group : undefined;
        out.push({ kind: "group", depth, id: gid, missing: gid === undefined ? String(p.group) : undefined, min, max, from, inChoice });
        if (gp && gid !== undefined && !groups.has(gid)) {
          groups.add(gid);
          this.particleRows(gp, from, depth + 1, false, out, groups);
          groups.delete(gid);
        }
        break;
      }
      default: {
        // A plain sequence of one occurrence directly in a type adds nothing to read.
        const skip = depth === 0 && p.t === "sequence" && min === 1 && max === 1;
        if (!skip) out.push({ kind: "compositor", compositor: p.t, depth, min, max, from, inChoice });
        for (const it of p.items) this.particleRows(it, from, skip ? depth : depth + 1, p.t === "choice", out, groups);
      }
    }
  }

  /** All attributes of a complex type (inherited and from groups), or of an attribute group. */
  attributes(id: Id): EffectiveAttr[] {
    const c = this.c[id];
    if (c.complexType?.effective?.attributes) return c.complexType.effective.attributes;
    const items = c.complexType?.attributes ?? c.attributeGroup?.attributes ?? [];
    const out: EffectiveAttr[] = [];
    const walk = (list: AttrItem[], via: Id | undefined, seen: Set<Id>) => {
      for (const a of list) {
        if (a.t === "attribute") out.push({ attr: a.attr, use: a.use, default: a.default, fixed: a.fixed, from: id, via });
        else if (isId(a.group) && !seen.has(a.group)) {
          seen.add(a.group);
          walk(this.c[a.group].attributeGroup?.attributes ?? [], via ?? a.group, seen);
        }
      }
    };
    walk(items, undefined, new Set());
    return out;
  }

  /** The attribute's type, through a reference. */
  attrType(r: Ref): Ref | undefined {
    if (!isId(r)) return undefined;
    return this.c[r].attribute?.type;
  }

  /** Who uses a component, grouped by the global component the use is in. */
  usedBy(id: Id): { owner: Id; by: Id; how: string }[] {
    const out: { owner: Id; by: Id; how: string }[] = [];
    const seen = new Set<string>();
    for (const u of this.c[id].usedBy ?? []) {
      const owner = this.owner(u.by);
      const key = `${owner}/${u.by}/${u.how}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ owner, by: u.by, how: u.how });
    }
    return out;
  }

  /** Global elements that nothing refers to: likely document roots. */
  rootElements(): Id[] {
    return this.lists.element.filter((id) => !(this.c[id].usedBy ?? []).some((u) => u.how === "element" || u.how === "substitution") && !this.c[id].element?.abstract);
  }

  /** Complex types per namespace, for the overview map. */
  namespacesOf(kind: "complexType" | "simpleType" | "element"): { ns: number | undefined; count: number }[] {
    const counts = new Map<number | undefined, number>();
    for (const id of this.lists[kind]) counts.set(this.c[id].ns, (counts.get(this.c[id].ns) ?? 0) + 1);
    return [...counts.entries()].map(([ns, count]) => ({ ns, count })).sort((a, b) => b.count - a.count);
  }

  /** Name search with a ranking, plus words of the documentation. */
  search(q: string, limit = 200): Id[] {
    const query = q.trim().toLowerCase();
    if (!query) return [];
    const words = query.split(/\s+/).filter(Boolean);
    const first = words[0].includes(":") ? words[0].slice(words[0].indexOf(":") + 1) : words[0];
    const scores = new Map<Id, number>();
    const add = (id: Id, s: number) => {
      if ((scores.get(id) ?? -1) < s) scores.set(id, s);
    };
    if (words.length === 1) {
      for (let i = 0; i < this.lowerNames.length; i++) {
        const n = this.lowerNames[i];
        if (!n) continue;
        const at = n.indexOf(first);
        if (at < 0) continue;
        const c = this.c[i];
        let s = n === first ? 100 : at === 0 ? 70 : 40;
        if (c.parent === undefined) s += 20;
        if (c.builtin) s -= 30;
        if (c.kind === "complexType" || c.kind === "element") s += 4;
        s -= Math.min(10, (n.length - first.length) / 4);
        add(i, s);
      }
    }
    // Documentation words (and name parts) from the bundle's index.
    const idx = this.b.search;
    if (idx) {
      if (!this.searchKeys) this.searchKeys = Object.keys(idx).sort();
      let acc: Set<Id> | null = null;
      for (const w of words) {
        const hits = new Set<Id>();
        for (const k of this.prefixKeys(w, 40)) for (const id of idx[k]) hits.add(id);
        const prev: Set<Id> | null = acc;
        acc = prev === null ? hits : new Set([...prev].filter((x: Id) => hits.has(x)));
      }
      for (const id of acc ?? []) {
        const c = this.c[id];
        add(id, 10 + (c.parent === undefined ? 10 : 0));
      }
    }
    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1] || (this.c[a[0]].name ?? "").localeCompare(this.c[b[0]].name ?? ""))
      .slice(0, limit)
      .map(([id]) => id);
  }

  private prefixKeys(w: string, max: number): string[] {
    const keys = this.searchKeys!;
    let lo = 0;
    let hi = keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (keys[mid] < w) lo = mid + 1;
      else hi = mid;
    }
    const out: string[] = [];
    for (let i = lo; i < keys.length && out.length < max && keys[i].startsWith(w); i++) out.push(keys[i]);
    return out;
  }
}

export function docsText(docs: Doc[] | undefined): string {
  if (!docs?.length) return "";
  const en = docs.filter((d) => !d.lang || d.lang.startsWith("en"));
  return (en.length ? en : docs).map((d) => d.text).join("\n\n");
}

export function occursText(min: number, max: number | null): string {
  if (min === 1 && max === 1) return "1";
  return `${min}..${max === null ? "*" : max}`;
}
