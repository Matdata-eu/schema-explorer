// A small sequence diff (Myers' O(ND) algorithm) for lines and for the
// words inside a changed line. No dependency: the inputs are short snippets.

export type OpKind = "eq" | "del" | "ins";
/** One step of an edit script; `a` / `b` are indexes into the old / new sequence. */
export interface Op {
  t: OpKind;
  a?: number;
  b?: number;
}

/** The shortest edit script that turns `a` into `b`. */
export function diffSeq<T>(a: readonly T[], b: readonly T[], eq: (x: T, y: T) => boolean = (x, y) => x === y): Op[] {
  // Common head and tail are cheap to take off first.
  let head = 0;
  while (head < a.length && head < b.length && eq(a[head], b[head])) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && eq(a[a.length - 1 - tail], b[b.length - 1 - tail])) tail++;
  const ops: Op[] = [];
  for (let i = 0; i < head; i++) ops.push({ t: "eq", a: i, b: i });
  const n = a.length - head - tail;
  const m = b.length - head - tail;
  const A = (i: number) => a[head + i];
  const B = (j: number) => b[head + j];
  if (n === 0 || m === 0) {
    for (let i = 0; i < n; i++) ops.push({ t: "del", a: head + i });
    for (let j = 0; j < m; j++) ops.push({ t: "ins", b: head + j });
  } else if (n * m > 25_000_000) {
    // Too big to be worth it: everything changed.
    for (let i = 0; i < n; i++) ops.push({ t: "del", a: head + i });
    for (let j = 0; j < m; j++) ops.push({ t: "ins", b: head + j });
  } else {
    const max = n + m;
    const off = max;
    const v = new Int32Array(2 * max + 2);
    const trace: Int32Array[] = [];
    let found = false;
    for (let d = 0; d <= max && !found; d++) {
      trace.push(v.slice());
      for (let k = -d; k <= d; k += 2) {
        let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
        let y = x - k;
        while (x < n && y < m && eq(A(x), B(y))) {
          x++;
          y++;
        }
        v[off + k] = x;
        if (x >= n && y >= m) {
          found = true;
          break;
        }
      }
    }
    // Walk back through the saved frontiers.
    const rev: Op[] = [];
    let x = n;
    let y = m;
    for (let d = trace.length - 1; d >= 0; d--) {
      const vd = trace[d];
      const k = x - y;
      const prevK = k === -d || (k !== d && vd[off + k - 1] < vd[off + k + 1]) ? k + 1 : k - 1;
      const px = d === 0 ? 0 : vd[off + prevK];
      const py = px - prevK;
      while (x > px && y > py) {
        x--;
        y--;
        rev.push({ t: "eq", a: head + x, b: head + y });
      }
      if (d === 0) break;
      if (x === px) rev.push({ t: "ins", b: head + --y });
      else rev.push({ t: "del", a: head + --x });
    }
    for (let i = rev.length - 1; i >= 0; i--) ops.push(rev[i]);
  }
  for (let i = 0; i < tail; i++) ops.push({ t: "eq", a: a.length - tail + i, b: b.length - tail + i });
  return ops;
}

export type RowKind = "eq" | "del" | "ins" | "chg";
/** A row of a side-by-side view: a line of the old text, of the new text, or both. */
export interface Row {
  t: RowKind;
  a?: number;
  b?: number;
}

/** Pair the removed and added lines of each change block, so a changed line sits next to its new form. */
export function pairRows(ops: Op[]): Row[] {
  const rows: Row[] = [];
  let dels: number[] = [];
  let ins: number[] = [];
  const flush = () => {
    const n = Math.max(dels.length, ins.length);
    for (let i = 0; i < n; i++) {
      const a = dels[i];
      const b = ins[i];
      rows.push(a !== undefined && b !== undefined ? { t: "chg", a, b } : a !== undefined ? { t: "del", a } : { t: "ins", b });
    }
    dels = [];
    ins = [];
  };
  for (const o of ops) {
    if (o.t === "eq") {
      flush();
      rows.push({ t: "eq", a: o.a, b: o.b });
    } else if (o.t === "del") dels.push(o.a!);
    else ins.push(o.b!);
  }
  flush();
  return rows;
}

/** Character ranges [from, to) that differ between two versions of a line, word by word. */
export function intraLine(a: string, b: string): { a: [number, number][]; b: [number, number][] } {
  const tok = (s: string) => s.match(/\w+|\s+|[^\w\s]/g) ?? [];
  const ta = tok(a);
  const tb = tok(b);
  const pa = offsets(ta);
  const pb = offsets(tb);
  const out = { a: [] as [number, number][], b: [] as [number, number][] };
  const push = (list: [number, number][], from: number, to: number) => {
    const last = list[list.length - 1];
    if (last && last[1] === from) last[1] = to;
    else list.push([from, to]);
  };
  // Whitespace counts as equal whatever its width, and is never highlighted on its own.
  const norm = (t: string) => (/^\s+$/.test(t) ? " " : t);
  for (const o of diffSeq(ta.map(norm), tb.map(norm))) {
    if (o.t === "del" && norm(ta[o.a!]) !== " ") push(out.a, pa[o.a!], pa[o.a!] + ta[o.a!].length);
    else if (o.t === "ins" && norm(tb[o.b!]) !== " ") push(out.b, pb[o.b!], pb[o.b!] + tb[o.b!].length);
  }
  return out;
}

function offsets(tokens: string[]): number[] {
  const out: number[] = [];
  let at = 0;
  for (const t of tokens) {
    out.push(at);
    at += t.length;
  }
  return out;
}
