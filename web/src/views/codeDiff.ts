// The source of a component in two versions and a line diff between them,
// drawn side by side (split) or unified. Shared by the side-by-side view of
// one component and the list of all changes.
import type { AppCtx } from "../ctx";
import { h, icon, plural } from "../dom";
import { jsonSource } from "../loader";
import type { Id } from "../model";
import { highlight, highlightJson, snippet } from "../source";
import { diffSeq, intraLine, pairRows, type Row } from "../textdiff";
import { link } from "./common";

/** The highlighted source of a component in one version, cut into lines. */
export interface SourceSide {
  text: string;
  /** The number of the first line in its file (1 for JSON, which is shown re-indented). */
  startLine: number;
  lines: HTMLElement[];
  where: string;
}

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

/**
 * The source of a component in the version `vctx` shows: the XSD declaration
 * cut from its file, or the JSON schema at its pointer. A string says why there is none.
 */
export async function loadSource(vctx: AppCtx, id: Id, title: string): Promise<SourceSide | string> {
  const m = vctx.m;
  const c = m.comp(id);
  if (c.file === undefined) return "No source location is known for it.";
  const file = c.file;
  const name = m.b.files[file]?.name ?? "";
  const text = await vctx.sourceText(file);
  if (text === null) return `The schema files of ${title} are not available here: the bundle was loaded without them.`;
  const linkTo = (target: Id, t: string) => link(vctx, target, t);
  if (c.json) {
    const pointer = c.json.pointer ?? "";
    let json: string;
    try {
      json = await jsonSource(name, text, pointer);
    } catch {
      return "Could not find the schema in the file.";
    }
    return { text: json, startLine: 1, lines: splitLines(highlightJson(m, file, json, linkTo)), where: `${name}#${pointer}` };
  }
  if (!c.line) return "No source location is known for it.";
  const sn = snippet(text, c.line);
  if (!sn) return "Could not find the declaration in the file.";
  return { text: sn.text, startLine: sn.startLine, lines: splitLines(highlight(m, file, sn.text, linkTo)), where: `${name}:${c.line}` };
}

/** The line diff of two sources, with the changed words of each changed line. */
export interface LineDiff {
  rows: Row[];
  ranges: Map<number, { a: [number, number][]; b: [number, number][] }>;
  /** Lines only in the new / only in the old source (a changed line counts in both). */
  added: number;
  removed: number;
}

export function lineDiff(a: SourceSide | null, b: SourceSide | null): LineDiff {
  const ta = a ? a.text.split("\n") : [];
  const tb = b ? b.text.split("\n") : [];
  // Lines differing only in indentation or spacing count as the same.
  const norm = (l: string) => l.trim().replace(/\s+/g, " ");
  const rows = pairRows(diffSeq(ta.map(norm), tb.map(norm)));
  const ranges: LineDiff["ranges"] = new Map();
  let added = 0;
  let removed = 0;
  rows.forEach((r, i) => {
    if (r.t === "chg") {
      // Word highlights help only when the lines are much alike; otherwise the whole line is the change.
      const rg = intraLine(ta[r.a!], tb[r.b!]);
      const len = (s: string) => s.replace(/\s+/g, "").length || 1;
      const marked = (list: [number, number][], s: string) => list.reduce((n, [f, t]) => n + s.slice(f, t).replace(/\s+/g, "").length, 0) / len(s);
      if (marked(rg.a, ta[r.a!]) < 0.65 || marked(rg.b, tb[r.b!]) < 0.65) ranges.set(i, rg);
    }
    if (r.t === "ins" || r.t === "chg") added++;
    if (r.t === "del" || r.t === "chg") removed++;
  });
  return { rows, ranges, added, removed };
}

export interface DiffTableOptions {
  unified: boolean;
  /** Unchanged lines kept around each change; longer stretches fold. Infinity shows all. */
  context: number;
  /** Put a `@@ -a,n +b,m @@ label` line above each hunk. */
  hunkLabel?: string;
  /** A note to show under the line `i` (0-based in the snippet) of the old (a) or new (b) side. */
  note?: (side: "a" | "b", i: number) => HTMLElement | null;
}

type Item = { row: number } | { fold: true; from: number; to: number };

/** Changed rows with `context` unchanged lines around them; longer unchanged stretches fold. */
function visibleRows(rows: Row[], context: number): Item[] {
  const all = rows.map((_, i) => ({ row: i }));
  if (!Number.isFinite(context)) return all;
  const keep = new Uint8Array(rows.length);
  rows.forEach((r, i) => {
    if (r.t === "eq") return;
    for (let j = Math.max(0, i - context); j <= Math.min(rows.length - 1, i + context); j++) keep[j] = 1;
  });
  if (!keep.some(Boolean)) return all;
  const out: Item[] = [];
  for (let i = 0; i < rows.length; ) {
    if (keep[i]) {
      out.push({ row: i++ });
      continue;
    }
    let j = i;
    while (j < rows.length && !keep[j]) j++;
    if (j - i <= 2) for (let k = i; k < j; k++) out.push({ row: k });
    else out.push({ fold: true, from: i, to: j });
    i = j;
  }
  return out;
}

/** Give the links of a cloned line the behaviour of the original's. */
function rewire(clone: HTMLElement, orig: HTMLElement): void {
  const a = clone.querySelectorAll("a");
  const b = orig.querySelectorAll("a");
  a.forEach((el, i) =>
    el.addEventListener("click", (ev) => {
      const me = ev as MouseEvent;
      if (me.metaKey || me.ctrlKey || me.shiftKey) return;
      ev.preventDefault();
      b[i]?.dispatchEvent(new MouseEvent("click", { bubbles: false, cancelable: true }));
    })
  );
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

const MK: Record<string, string> = { del: "−", ins: "+", chg: "~", eq: "" };

/** The line diff as a table: split (old left, new right, rows aligned) or unified (removed lines above added ones). */
export function diffTable(a: SourceSide | null, b: SourceSide | null, d: LineDiff, o: DiffTableOptions): HTMLTableElement {
  const { rows, ranges } = d;
  const unified = o.unified;
  const cols = unified ? 4 : 6;
  const table = h("table", { class: `codediff-table ${unified ? "unified" : "split"}` });
  if (!unified) table.appendChild(h("colgroup", null, h("col", { class: "c-ln" }), h("col", { class: "c-mk" }), h("col", { class: "c-code" }), h("col", { class: "c-ln" }), h("col", { class: "c-mk" }), h("col", { class: "c-code" })));
  else table.appendChild(h("colgroup", null, h("col", { class: "c-ln" }), h("col", { class: "c-ln" }), h("col", { class: "c-mk" }), h("col", { class: "c-code" })));

  const line = (side: "a" | "b", i: number, ri: number): HTMLElement => {
    const src = side === "a" ? a! : b!;
    const el = src.lines[i].cloneNode(true) as HTMLElement;
    // Clones lose the listeners of the links: put them back by delegating to the original.
    rewire(el, src.lines[i]);
    const rg = ranges.get(ri);
    if (rg) markRanges(el, side === "a" ? rg.a : rg.b);
    return el;
  };
  const code = (side: "a" | "b", i: number | undefined, ri: number) => (i === undefined ? h("td", { class: "code blank" }) : h("td", { class: "code" }, line(side, i, ri)));
  const num = (n: number | undefined, base: number | undefined) => h("td", { class: "ln" }, n === undefined || base === undefined ? "" : String(base + n));
  const mk = (t: string) => h("td", { class: "mk", "aria-hidden": t ? undefined : "true" }, t ? h("span", { class: "dmark" }, t) : "");
  const noteRow = (notes: (HTMLElement | null)[]): HTMLElement[] => {
    const n = notes.filter((x): x is HTMLElement => !!x);
    return n.length ? [h("tr", { class: "cd-note" }, h("td", { colspan: cols }, n))] : [];
  };
  const note = (side: "a" | "b", i: number | undefined) => (o.note && i !== undefined ? o.note(side, i) : null);

  /** The table rows of a run of diff rows; in the unified layout a block's removed lines come before its added ones. */
  const rowEls = (from: number, to: number): HTMLElement[] => {
    const out: HTMLElement[] = [];
    for (let k = from; k < to; ) {
      const r = rows[k];
      if (!unified) {
        out.push(h("tr", { class: `cd-${r.t}` }, num(r.a, a?.startLine), mk(r.t === "eq" || r.t === "ins" ? "" : MK[r.t]), code("a", r.a, k), num(r.b, b?.startLine), mk(r.t === "eq" || r.t === "del" ? "" : MK[r.t]), code("b", r.b, k)));
        out.push(...noteRow([note("a", r.t === "eq" ? undefined : r.a), note("b", r.b)]));
        k++;
        continue;
      }
      if (r.t === "eq") {
        out.push(h("tr", { class: "cd-eq" }, num(r.a, a?.startLine), num(r.b, b?.startLine), mk(""), code("b", r.b, k)));
        out.push(...noteRow([note("b", r.b)]));
        k++;
        continue;
      }
      let e = k;
      while (e < to && rows[e].t !== "eq") e++;
      for (let x = k; x < e; x++) {
        const q = rows[x];
        if (q.a === undefined) continue;
        out.push(h("tr", { class: "cd-del" + (q.t === "chg" ? " cd-pair" : "") }, num(q.a, a?.startLine), h("td", { class: "ln" }), mk("−"), code("a", q.a, x)));
        out.push(...noteRow([note("a", q.a)]));
      }
      for (let x = k; x < e; x++) {
        const q = rows[x];
        if (q.b === undefined) continue;
        out.push(h("tr", { class: "cd-ins" + (q.t === "chg" ? " cd-pair" : "") }, h("td", { class: "ln" }), num(q.b, b?.startLine), mk("+"), code("b", q.b, x)));
        out.push(...noteRow([note("b", q.b)]));
      }
      k = e;
    }
    return out;
  };

  const hunkHead = (from: number, to: number): HTMLElement | null => {
    if (o.hunkLabel === undefined) return null;
    const slice = rows.slice(from, to);
    const fa = slice.find((r) => r.a !== undefined);
    const fb = slice.find((r) => r.b !== undefined);
    const na = slice.filter((r) => r.a !== undefined).length;
    const nb = slice.filter((r) => r.b !== undefined).length;
    const sa = fa && a ? a.startLine + fa.a! : 0;
    const sb = fb && b ? b.startLine + fb.b! : 0;
    return h("tr", { class: "cd-hunk" }, h("td", { colspan: cols }, `@@ -${sa},${na} +${sb},${nb} @@ ${o.hunkLabel}`));
  };

  const tbody = h("tbody");
  const items = visibleRows(rows, o.context);
  for (let i = 0; i < items.length; ) {
    const it = items[i];
    if ("fold" in it) {
      const btn = h("button", { type: "button", class: "fold-btn", onClick: () => tr.replaceWith(...rowEls(it.from, it.to)) }, icon("plus"), ` Show ${plural(it.to - it.from, "unchanged line")}`);
      const tr = h("tr", { class: "fold" }, h("td", { colspan: cols }, btn));
      tbody.appendChild(tr);
      i++;
      continue;
    }
    // A hunk: the shown rows up to the next fold.
    let j = i;
    while (j < items.length && !("fold" in items[j])) j++;
    const from = (it as { row: number }).row;
    const to = (items[j - 1] as { row: number }).row + 1;
    const head = hunkHead(from, to);
    if (head) tbody.appendChild(head);
    tbody.append(...rowEls(from, to));
    i = j;
  }
  table.appendChild(tbody);
  return table;
}
