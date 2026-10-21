// Comparison of two versions of a schema set: the diff made by the core
// (see crates/core/src/diff.rs) and lookups for the views that highlight it.
import type { GraphSpec } from "./graph";
import { KIND_SLUG, type Id, type Kind, type Model } from "./model";

export type Status = "added" | "removed" | "changed";
export type Impact = "breaking" | "nonBreaking" | "info";
/** How a box, line or tree node differs from the earlier version. */
export type Mark = Status;

export interface Change {
  kind: string;
  impact: Impact;
  path?: string;
  subject?: string;
  old?: string;
  new?: string;
}

export interface Side {
  id: Id;
  qname: string;
  file?: string;
  line?: number;
}

export interface ComponentDiff {
  kind: Kind;
  status: Status;
  name: string;
  namespace?: string;
  old?: Side;
  new?: Side;
  byLocalName?: boolean;
  impact: Impact;
  changes?: Change[];
  possiblyRenamed?: string;
}

export interface Counts {
  added: number;
  removed: number;
  changed: number;
  breaking: number;
  docsOnly: number;
}

export interface SetInfo {
  title?: string;
  version?: string;
  versions?: string[];
  files: number;
  namespaces: string[];
  components: number;
}

export interface SchemaDiff {
  format: number;
  generator: string;
  options: { matchLocalNames: boolean; docs: boolean; renames: boolean };
  old: SetInfo;
  new: SetInfo;
  namespaceMap?: Record<string, string>;
  summary: {
    total: Counts;
    byKind: Partial<Record<Kind, Counts>>;
    byNamespace: Record<string, Counts>;
    byFile: Record<string, Counts>;
    changes: Record<string, number>;
    breakingChanges: number;
    possiblyRenamed: number;
  };
  components: ComponentDiff[];
  renames?: { kind: Kind; old: Side; new: Side; score: number }[];
}

export const MARKER: Record<Status, string> = { added: "+", removed: "−", changed: "~" };
export const STATUS_LABEL: Record<Status, string> = { added: "Added", removed: "Removed", changed: "Changed" };

const LABELS: Record<string, string> = {
  kindChanged: "kind changed",
  baseChanged: "base type changed",
  derivationChanged: "derivation changed",
  abstractChanged: "abstract changed",
  finalChanged: "final changed",
  blockChanged: "block changed",
  mixedChanged: "mixed changed",
  nillableChanged: "nillable changed",
  typeChanged: "type changed",
  valueConstraintChanged: "value constraint changed",
  substitutionGroupChanged: "substitution group changed",
  substitutionMemberAdded: "substitution member added",
  substitutionMemberRemoved: "substitution member removed",
  childAdded: "child added",
  childRemoved: "child removed",
  childRetyped: "child retyped",
  childCardinalityChanged: "cardinality changed",
  childrenReordered: "children reordered",
  childMoved: "child moved",
  structureChanged: "structure changed",
  attributeAdded: "attribute added",
  attributeRemoved: "attribute removed",
  attributeRetyped: "attribute retyped",
  attributeUseChanged: "attribute use changed",
  attributeDefaultChanged: "attribute default changed",
  attributeFixedChanged: "attribute fixed value changed",
  anyAttributeChanged: "anyAttribute changed",
  enumerationAdded: "enumeration value added",
  enumerationRemoved: "enumeration value removed",
  facetAdded: "facet added",
  facetRemoved: "facet removed",
  facetChanged: "facet changed",
  varietyChanged: "variety changed",
  itemTypeChanged: "list item type changed",
  memberTypeAdded: "union member added",
  memberTypeRemoved: "union member removed",
  assertAdded: "assertion added",
  assertRemoved: "assertion removed",
  docsChanged: "documentation changed",
};

export const changeLabel = (k: string): string => LABELS[k] ?? k;

/** The marker of a change: + for additions, − for removals, ~ otherwise. */
export function changeMark(k: string): Status {
  if (/Added$/.test(k)) return "added";
  if (/Removed$/.test(k)) return "removed";
  return "changed";
}

/** The local part of a subject: `@rail3:foo` → `foo`. */
const local = (s: string) => {
  const t = s.replace(/^@/, "");
  return t.slice(t.lastIndexOf(":") + 1);
};

export interface ChildMarks {
  children: Map<string, Mark>;
  removed: { name: string; mult?: string }[];
  attrs: Map<string, Mark>;
  removedAttrs: { name: string; use?: string }[];
}

const NONE: ChildMarks = { children: new Map(), removed: [], attrs: new Map(), removedAttrs: [] };

/** Both versions and the diff between them; `cur` is the later version, the one the viewer shows. */
export class Compare {
  readonly byNew = new Map<Id, ComponentDiff>();
  readonly byOld = new Map<Id, ComponentDiff>();
  private marks = new Map<Id, ChildMarks>();
  private oldSources: ((file: number, name: string) => Promise<string | null>) | null = null;
  private oldCache = new Map<number, Promise<string | null>>();
  /** Where the earlier version's .xsd files are, when given apart from its bundle (for share links). */
  oldSourcesUrl?: string;

  constructor(
    readonly old: Model,
    readonly cur: Model,
    readonly d: SchemaDiff,
    /** Where the earlier version came from, for share links. */
    readonly oldUrl?: string
  ) {
    for (const c of d.components) {
      if (c.new) this.byNew.set(c.new.id, c);
      if (c.old) this.byOld.set(c.old.id, c);
    }
  }

  /** Where the text of the earlier version's schema files comes from. */
  setOldSources(p: (file: number, name: string) => Promise<string | null>, url?: string): void {
    this.oldSources = p;
    this.oldSourcesUrl = url;
    this.oldCache.clear();
  }

  /** The text of a schema file of the earlier version, when it can be had. */
  oldSourceText(file: number): Promise<string | null> {
    if (!this.oldSources) return Promise.resolve(null);
    let p = this.oldCache.get(file);
    if (!p) {
      p = this.oldSources(file, this.old.b.files[file]?.name ?? "");
      this.oldCache.set(file, p);
    }
    return p;
  }

  get oldTitle(): string {
    return this.d.old.title ?? (this.d.old.version ? `version ${this.d.old.version}` : this.old.title);
  }

  get newTitle(): string {
    return this.d.new.title ?? (this.d.new.version ? `version ${this.d.new.version}` : this.cur.title);
  }

  /** The mark of a global component of the later version. */
  mark(id: Id): Mark | undefined {
    return this.byNew.get(id)?.status;
  }

  /** The diff entry for a link `#/diff/<slug>/<qname>`. */
  find(slug: string, qname: string): ComponentDiff | undefined {
    return this.d.components.find((c) => KIND_SLUG[c.kind] === slug && (c.new?.qname ?? c.old?.qname) === qname);
  }

  /** The global component and the path of local names that lead to a (possibly anonymous) type of the later version. */
  private locate(id: Id): { cd: ComponentDiff; path: string } | undefined {
    const m = this.cur;
    const names: string[] = [];
    let cur: Id | undefined = id;
    for (let i = 0; cur !== undefined && i < 30; i++) {
      const c = m.comp(cur);
      if (c.parent === undefined) {
        const cd = this.byNew.get(cur);
        return cd ? { cd, path: names.join("/") } : undefined;
      }
      if (c.kind === "element" && c.name) names.unshift(c.name);
      cur = c.parent;
    }
    return undefined;
  }

  /** What changed among the children and attributes a type (or group) declares itself. */
  childMarks(owner: Id): ChildMarks {
    let r = this.marks.get(owner);
    if (r) return r;
    const at = this.locate(owner);
    if (!at || at.cd.status !== "changed") {
      r = NONE;
    } else {
      r = { children: new Map(), removed: [], attrs: new Map(), removedAttrs: [] };
      const prefix = at.path ? at.path + "/" : "";
      for (const ch of at.cd.changes ?? []) {
        const p = ch.path ?? "";
        const subj = ch.subject ?? "";
        if (p !== at.path) {
          // A change deeper down marks the child it is under.
          if (p.startsWith(prefix) && ch.impact !== "info") {
            const first = p.slice(prefix.length).split("/")[0];
            if (first && !r.children.has(first)) r.children.set(first, "changed");
          }
          continue;
        }
        if (ch.impact === "info" || !subj || subj.startsWith("group ") || subj.startsWith("attributeGroup ")) continue;
        if (subj.startsWith("@")) {
          const n = local(subj);
          if (ch.kind === "attributeRemoved") r.removedAttrs.push({ name: n, use: ch.old });
          else if (ch.kind === "attributeAdded") r.attrs.set(n, "added");
          else if (!r.attrs.has(n)) r.attrs.set(n, "changed");
        } else if (ch.kind.startsWith("child") && ch.kind !== "childrenReordered") {
          const n = local(subj);
          if (ch.kind === "childRemoved") r.removed.push({ name: n, mult: ch.old });
          else if (ch.kind === "childAdded") r.children.set(n, "added");
          else if (!r.children.has(n)) r.children.set(n, "changed");
        }
      }
    }
    this.marks.set(owner, r);
    return r;
  }
}

/** Mark what changed in a diagram of the later version: boxes, lines and arrows get a class and a +/−/~ prefix. */
export function annotateGraph(g: GraphSpec, cmp: Compare): void {
  const m = cmp.cur;
  const prefix = (d: Mark | undefined, t: string) => (d ? `${MARKER[d]} ${t}` : t);
  for (const n of g.nodes) {
    if (n.id === undefined) continue;
    n.diff = cmp.mark(n.id);
    if (n.diff) n.name = prefix(n.diff, n.name);
    if (n.kind === "enum") {
      const cd = cmp.byNew.get(n.id);
      if (cd?.status !== "changed") continue;
      const added = new Set((cd.changes ?? []).filter((c) => c.kind === "enumerationAdded" && !c.path).map((c) => c.subject));
      for (const a of n.attrs) if (added.has(a.text)) Object.assign(a, { diff: "added", text: prefix("added", a.text) });
      for (const c of cd.changes ?? []) if (c.kind === "enumerationRemoved" && !c.path && c.subject) n.attrs.push({ text: prefix("removed", c.subject), diff: "removed" });
      continue;
    }
    if (n.kind !== "class") continue;
    const cm = cmp.childMarks(n.id);
    for (const a of n.attrs) {
      if (a.inherited) continue;
      const d = a.text.startsWith("@") ? cm.attrs.get(a.text.slice(1)) : cm.children.get(a.text);
      if (d) Object.assign(a, { diff: d, text: prefix(d, a.text) });
    }
    for (const r of cm.removedAttrs) n.attrs.push({ text: prefix("removed", "@" + r.name), diff: "removed" });
    for (const r of cm.removed) n.attrs.push({ text: prefix("removed", r.name), mult: r.mult, diff: "removed" });
  }
  for (const e of g.edges) {
    if (e.kind !== "comp" || e.id === undefined || !e.from.startsWith("c")) continue;
    const from = Number(e.from.slice(1));
    const d = cmp.childMarks(from).children.get(m.comp(e.id).name ?? "");
    if (d) Object.assign(e, { diff: d, label: prefix(d, e.label ?? "") });
  }
}
