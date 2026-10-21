// The raw XSD of one component: cut out of its file from the declaration's
// line to its end tag, then highlighted with the type names linked.
import type { Id, Model } from "./model";

/** The element that starts on `line` (1-based), with its end tag. */
export function snippet(text: string, line: number): { text: string; startLine: number } | null {
  let pos = 0;
  for (let l = 1; l < line && pos >= 0; l++) pos = text.indexOf("\n", pos) + (pos >= 0 ? 1 : 0);
  if (pos < 0) return null;
  const lineStart = pos;
  // The first start tag at or after the line start.
  let start = -1;
  for (let i = pos; i < text.length; i++) {
    if (text[i] !== "<") continue;
    const n = text[i + 1];
    if (n === "!" || n === "?" || n === "/") continue;
    start = i;
    break;
  }
  if (start < 0) return null;
  let depth = 0;
  let i = start;
  while (i < text.length) {
    const lt = text.indexOf("<", i);
    if (lt < 0) return null;
    if (text.startsWith("<!--", lt)) {
      const e = text.indexOf("-->", lt + 4);
      i = e < 0 ? text.length : e + 3;
      continue;
    }
    if (text.startsWith("<![CDATA[", lt)) {
      const e = text.indexOf("]]>", lt);
      i = e < 0 ? text.length : e + 3;
      continue;
    }
    if (text[lt + 1] === "?" || text[lt + 1] === "!") {
      i = text.indexOf(">", lt) + 1 || text.length;
      continue;
    }
    // Find the end of the tag, skipping quoted attribute values.
    let j = lt + 1;
    let q = "";
    for (; j < text.length; j++) {
      const ch = text[j];
      if (q) {
        if (ch === q) q = "";
      } else if (ch === '"' || ch === "'") q = ch;
      else if (ch === ">") break;
    }
    const closing = text[lt + 1] === "/";
    const selfClosing = text[j - 1] === "/";
    if (closing) depth--;
    else if (!selfClosing) depth++;
    i = j + 1;
    if (depth <= 0) break;
  }
  // Keep the indentation of the first line, then remove what all lines share.
  const lines = text.slice(lineStart, i).split("\n");
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)![0].length));
  const out = lines.map((l) => l.slice(Math.min(indent, /^\s*/.exec(l)![0].length))).join("\n");
  return { text: out.replace(/\s+$/, ""), startLine: line };
}

const LINKED: Record<string, string[]> = {
  type: ["ct", "st"],
  base: ["ct", "st"],
  itemType: ["st"],
  memberTypes: ["st"],
  substitutionGroup: ["el"],
  refer: [],
};

const TOKEN = /(<!--[\s\S]*?-->)|(<\/?)([\w.:-]+)|([\w.:-]+)(\s*=\s*)("[^"]*"|'[^']*')|(\/?>)/g;

/** Highlighted XSD with QName values linked to their pages. */
export function highlight(m: Model, file: number, text: string, link: (id: Id, text: string) => HTMLElement): HTMLElement {
  const pre = document.createElement("pre");
  pre.className = "xml";
  const prefixes = m.b.files[file]?.prefixes ?? {};
  const span = (cls: string, t: string) => {
    const s = document.createElement("span");
    s.className = cls;
    s.textContent = t;
    return s;
  };
  let tag = "";
  let at = 0;
  for (const t of text.matchAll(TOKEN)) {
    if (t.index > at) pre.append(text.slice(at, t.index));
    at = t.index + t[0].length;
    if (t[1]) pre.append(span("t-com", t[1]));
    else if (t[3]) {
      tag = t[3].replace(/^.*:/, "");
      pre.append(span("t-kw", t[2]), span("t-tag", t[3]));
    } else if (t[4]) {
      const attr = t[4];
      pre.append(span("t-attr", attr), t[5]);
      const quote = t[6][0];
      const value = t[6].slice(1, -1);
      const kinds = attr === "ref" ? [tag === "element" ? "el" : tag === "attribute" ? "at" : tag === "group" ? "gr" : tag === "attributeGroup" ? "ag" : ""] : LINKED[attr];
      if (kinds && kinds.length && kinds[0]) {
        pre.append(span("t-str", quote));
        value.split(/(\s+)/).forEach((part) => {
          const id = part.trim() ? resolve(m, prefixes, part, kinds) : undefined;
          if (id !== undefined) {
            const a = link(id, part);
            a.classList.add("t-iri");
            pre.append(a);
          } else pre.append(span("t-str", part));
        });
        pre.append(span("t-str", quote));
      } else pre.append(span("t-str", t[6]));
    } else if (t[7]) pre.append(span("t-kw", t[7]));
  }
  pre.append(text.slice(at));
  return pre;
}

function resolve(m: Model, prefixes: Record<string, string>, qname: string, kinds: string[]): Id | undefined {
  const i = qname.indexOf(":");
  const p = i < 0 ? "" : qname.slice(0, i);
  const local = i < 0 ? qname : qname.slice(i + 1);
  const uri = prefixes[p];
  const ns = uri === undefined ? -1 : m.b.namespaces.findIndex((n) => n.uri === uri);
  const display = ns >= 0 ? m.b.namespaces[ns].prefix : "";
  for (const k of kinds) {
    const id = m.find(k, display ? `${display}:${local}` : local);
    if (id !== undefined) return id;
  }
  return undefined;
}
