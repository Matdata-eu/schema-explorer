// Compare mode, all changes on one page in the manner of a pull request's
// "Files changed": a tree of the changed components by schema file on the left,
// a card per component on the right with what changed and its source diff.
import type { AppCtx } from "../ctx";
import { MARKER, STATUS_LABEL, changeLabel, changeMark, type Change, type Compare, type ComponentDiff, type Impact } from "../diff";
import { button, h, icon, plural, type Child } from "../dom";
import { KIND_LABEL, KIND_SLUG, LANG, type Kind } from "../model";
import { diffTable, lineDiff, loadSource, type LineDiff, type SourceSide } from "./codeDiff";
import { diffHref, diffTabs, mark, qnameOf } from "./compare";
import { whenVisible } from "./diagramPanel";
import { versionCtx, type Which } from "./sideBySide";

const KINDS: Kind[] = ["complexType", "simpleType", "element", "attribute", "group", "attributeGroup"];
const SHOW = ["all", "breaking", "added", "removed", "changed", "unviewed"] as const;
type Show = (typeof SHOW)[number];
const SHOW_LABEL: Record<Show, string> = { all: "All changes", breaking: "Breaking only", added: "Added", removed: "Removed", changed: "Changed", unviewed: "Not viewed yet" };
const IMPACT_LABEL: Record<Impact, string> = { breaking: "Breaking", nonBreaking: "Non-breaking", info: "Docs" };
/** Added and removed components longer than this start folded. */
const LONG = 60;
/** Below this width the tree is a drawer; below NARROW the diff is always unified. */
const WIDE = 1100;
const NARROW = 700;

/** Folders closed in the tree, kept while the page is open. */
const closedFiles = new Set<string>();

interface Source {
  a: SourceSide | null;
  b: SourceSide | null;
  d: LineDiff;
  problems: string[];
}

interface Item {
  c: ComponentDiff;
  /** `slug/qname`, as in the component's diff link. */
  key: string;
  dom: string;
  file: string;
  prefix: string;
  local: string;
  /** "renamed" for an added or removed component that looks renamed. */
  st: "added" | "removed" | "changed" | "renamed";
  docsOnly: boolean;
  el?: HTMLElement;
  body?: HTMLElement;
  stat?: HTMLElement;
  viewBtn?: HTMLButtonElement;
  collapsed: boolean;
  filled: boolean;
  forced: boolean;
  src?: Promise<Source | string>;
  srcDone?: Source;
}

const storeGet = (k: string): string[] => {
  try {
    const v = localStorage.getItem(k);
    const x: unknown = v ? JSON.parse(v) : [];
    return Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
};
const storeSet = (k: string, v: string[]) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* private mode: viewed marks last for the page only */
  }
};

/** The marker square of a component: + − ~, or → for a likely rename. */
function square(st: Item["st"]): HTMLElement {
  const label = st === "renamed" ? "Possibly renamed" : STATUS_LABEL[st];
  return h("span", { class: `dsq d-${st}`, title: label, "aria-label": label }, st === "renamed" ? "→" : MARKER[st]);
}

/** Five blocks in proportion to added and removed lines, as on a pull request. */
function blocks(add: number, del: number): HTMLElement {
  const tot = add + del;
  const n = 5;
  let a = tot ? Math.round((add / tot) * n) : 0;
  let d = tot ? Math.min(n - a, Math.round((del / tot) * n)) : 0;
  if (add && !a) a = 1;
  if (del && !d && a < n) d = 1;
  if (a + d > n) a = n - d;
  const s = h("span", { class: "df-blocks", "aria-hidden": "true" });
  for (let i = 0; i < n; i++) s.append(h("i", { class: i < a ? "a" : i < a + d ? "d" : "" }));
  return s;
}

const clip = (v: string) => (v.length > 160 ? v.slice(0, 160) + "…" : v);

/** One semantic change: impact, what, where, old → new. */
function changeText(ch: Change): Child[] {
  const what = changeLabel(ch.kind);
  const out: Child[] = [h("span", { class: `df-imp ${ch.impact}` }, IMPACT_LABEL[ch.impact]), h("span", { class: `df-lbl d-${changeMark(ch.kind)}-text` }, what[0].toUpperCase() + what.slice(1))];
  const where = [ch.path, ch.subject].filter(Boolean).join("/");
  if (where) out.push(h("code", null, where));
  if (ch.kind !== "docsChanged" && (ch.old !== undefined || ch.new !== undefined)) {
    if (ch.old !== undefined) out.push(h("code", { class: "df-old" }, clip(ch.old)));
    if (ch.old !== undefined && ch.new !== undefined) out.push("→");
    if (ch.new !== undefined) out.push(h("code", { class: "df-new" }, clip(ch.new)));
  }
  return out;
}

/** Which source line each semantic change is about, found by what the change names. */
function annotate(c: ComponentDiff, src: Source): { a: Map<number, Change[]>; b: Map<number, Change[]> } {
  const map = { a: new Map<number, Change[]>(), b: new Map<number, Change[]>() };
  if (c.status !== "changed") return map;
  const la = src.a ? src.a.text.split("\n") : [];
  const lb = src.b ? src.b.text.split("\n") : [];
  for (const ch of c.changes ?? []) {
    if (ch.kind === "docsChanged") continue;
    let side: "a" | "b" = /Removed$/.test(ch.kind) ? "a" : "b";
    if (side === "a" ? !src.a : !src.b) side = side === "a" ? "b" : "a";
    const lines = side === "a" ? la : lb;
    const subj = (ch.subject ?? "").replace(/^@/, "").split(",")[0].trim();
    const local = subj.slice(subj.lastIndexOf(":") + 1);
    let pats: string[];
    if (LANG.json) {
      pats = /^enumeration/.test(ch.kind) ? [`"${subj}"`] : local ? [`"${local}":`, `"${local}"`] : [];
    } else if (/^enumeration/.test(ch.kind)) pats = [`value="${subj}"`];
    else if (/^facet/.test(ch.kind)) pats = [`:${subj} `, `:${subj}>`];
    else if (ch.kind === "baseChanged") pats = ["base="];
    else if (ch.kind === "typeChanged") pats = ["type="];
    else if (ch.kind === "substitutionGroupChanged") pats = ["substitutionGroup="];
    else if (/^memberType/.test(ch.kind)) pats = [subj, "memberTypes="];
    else if (ch.kind === "itemTypeChanged") pats = ["itemType="];
    else if (ch.kind === "structureChanged") pats = [":sequence", ":choice", ":all"];
    else pats = local ? [`name="${local}"`, `ref="${subj}"`, `:${local}"`, `"${local}"`] : [];
    let at = -1;
    for (const p of pats) {
      at = lines.findIndex((l) => l.includes(p));
      if (at >= 0) break;
    }
    if (at < 0) at = 0;
    const m = map[side];
    if (!m.has(at)) m.set(at, []);
    m.get(at)!.push(ch);
  }
  return map;
}

/** The pair of versions, so marks of one comparison do not show on another. */
const viewedKey = (cmp: Compare) => `se.viewed:${cmp.oldTitle}|${cmp.newTitle}|${cmp.cur.title}`;

/** Every changed component with its source diff, filters and a viewed mark, kept in the link. */
export function diffFilesPage(ctx: AppCtx, cmp: Compare): HTMLElement {
  const d = cmp.d;
  const P = ctx.route.params;
  const t = d.summary.total;
  const vkey = viewedKey(cmp);
  const viewed = new Set(storeGet(vkey));
  const wide = () => window.innerWidth >= WIDE;

  const items: Item[] = d.components.map((c, i) => {
    const q = qnameOf(c);
    const colon = q.indexOf(":");
    return {
      c,
      key: `${KIND_SLUG[c.kind]}/${q}`,
      dom: `dc-${i}`,
      file: (c.new ?? c.old)?.file ?? "(no file)",
      prefix: colon > 0 ? q.slice(0, colon + 1) : "",
      local: colon > 0 ? q.slice(colon + 1) : q,
      st: c.possiblyRenamed && c.status !== "changed" ? "renamed" : c.status,
      docsOnly: c.status === "changed" && c.impact === "info",
      collapsed: false,
      filled: false,
      forced: false,
    };
  });

  // ---- state kept in the link ------------------------------------------------
  const state = {
    show: (SHOW as readonly string[]).includes(P.show ?? "") ? (P.show as Show) : "all",
    k: P.k ?? "",
    docs: P.docs !== "0",
    q: P.q ?? "",
    unified: P.code === "unified",
    nav: P.nav !== "0",
  };
  const save = () => ctx.setParams({ show: state.show === "all" ? undefined : state.show, k: state.k || undefined, docs: state.docs ? undefined : "0", q: state.q || undefined, code: state.unified ? "unified" : undefined, nav: state.nav ? undefined : "0" });
  const unifiedNow = () => state.unified || window.innerWidth < NARROW;

  // ---- head --------------------------------------------------------------------
  const page = h("div", { class: "diff-page diff-files" });
  const kbd = (k: string) => h("kbd", null, k);
  page.append(
    h("header", { class: "page-head" }, h("h1", null, "Changes from ", h("span", { class: "d-removed-text" }, cmp.oldTitle), " to ", h("span", { class: "d-added-text" }, cmp.newTitle))),
    h(
      "p",
      { class: "df-sub" },
      h("span", null, h("strong", null, (t.added + t.removed + t.changed).toLocaleString()), " components in ", h("strong", null, Object.keys(d.summary.byFile).length.toLocaleString()), " files"),
      h("span", null, mark("added"), t.added.toLocaleString(), " ", mark("removed"), t.removed.toLocaleString(), " ", mark("changed"), t.changed.toLocaleString()),
      h("span", null, h("strong", { class: "d-removed-text" }, d.summary.breakingChanges.toLocaleString()), ` breaking ${d.summary.breakingChanges === 1 ? "change" : "changes"} in `, h("strong", null, t.breaking.toLocaleString()), " components"),
      h("span", { class: "df-keys hide-mobile" }, kbd("j"), kbd("k"), " next / previous ", kbd("v"), " viewed ", kbd("s"), " split ", kbd("t"), " tree ", kbd("/"), " filter")
    )
  );
  const tabCount = h("span", { class: "count" });
  page.append(diffTabs(ctx, cmp, "files", tabCount));

  // ---- toolbar ---------------------------------------------------------------
  const opt = (v: string, label: string, cur: string) => h("option", { value: v, selected: v === cur }, label);
  const showSel = h("select", { class: "input", "aria-label": "Show" }, SHOW.map((s) => opt(s, SHOW_LABEL[s], state.show))) as HTMLSelectElement;
  const kindSel = h("select", { class: "input", "aria-label": "Kind" }, opt("", "All kinds", state.k), KINDS.filter((x) => d.summary.byKind[x]).map((x) => opt(KIND_SLUG[x], KIND_LABEL[x], state.k))) as HTMLSelectElement;
  const docsBox = h("input", { type: "checkbox", checked: !state.docs }) as HTMLInputElement;
  const vText = h("span");
  const vBar = h("i");
  const splitBtn = button("Split", () => setMode(false), { cls: "small", pressed: !state.unified, title: "Old on the left, new on the right (s)" });
  const uniBtn = button("Unified", () => setMode(true), { cls: "small", pressed: state.unified, title: "Removed lines above added ones (s)" });
  const collapseBtn = button("Collapse all", () => {
    const anyOpen = shown.some((it) => !it.collapsed);
    shown.forEach((it) => setCollapsed(it, anyOpen));
    collapseBtn.querySelector("span")!.textContent = anyOpen ? "Expand all" : "Collapse all";
  }, { cls: "small" });
  const navBtn = button("Tree", () => toggleNav(), { cls: "small", icon: "columns", title: "Show or hide the component tree (t)" });
  const toolbar = h(
    "div",
    { class: "df-toolbar" },
    navBtn,
    showSel,
    kindSel,
    h("label", { class: "df-check" }, docsBox, " Hide docs-only"),
    h("span", { class: "spacer" }),
    h("span", { class: "df-progress", title: "Components you marked as viewed" }, vText, h("span", { class: "df-pbar" }, vBar)),
    h("div", { class: "btn-group df-layout", role: "group", "aria-label": "Diff layout" }, splitBtn, uniBtn),
    collapseBtn
  );
  page.append(toolbar);

  // ---- tree and cards ----------------------------------------------------------
  const search = h("input", { class: "input", type: "search", placeholder: "Filter components…", value: state.q, "aria-label": "Filter components", autocomplete: "off" }) as HTMLInputElement;
  const tree = h("nav", { class: "df-tree", "aria-label": "Changed components" });
  const side = h("aside", { class: "df-side" }, h("div", { class: "df-search" }, search, button("", () => toggleNav(false), { cls: "small icon-only ghost df-close", icon: "close", title: "Close the tree" })), tree);
  const cards = h("div", { class: "df-cards" });
  const shell = h("div", { class: "df-shell" }, side, cards);
  page.append(shell);

  // ---- one card ---------------------------------------------------------------
  const openHref = (c: ComponentDiff) => (c.new ? ctx.href(c.new.id) : c.old ? ctx.hrefRoute({ view: "old", id: c.old.id }) : null);
  const navLink = (href: string, go: () => void, ic: string, title: string) =>
    h("a", { class: "btn small icon-only ghost", href, title, "aria-label": title, onClick: (ev: Event) => {
      const me = ev as MouseEvent;
      if (me.metaKey || me.ctrlKey || me.shiftKey) return;
      ev.preventDefault();
      go();
    } }, icon(ic));
  const where = (c: ComponentDiff) => {
    const f = (c.new ?? c.old)?.file ?? "";
    const o = c.old?.line;
    const n = c.new?.line;
    if (c.status === "added" || o === undefined) return n === undefined ? f : `${f}:${n}`;
    if (c.status === "removed" || n === undefined) return `${f}:${o}`;
    const fo = c.old?.file && c.old.file !== c.new?.file ? `${c.old.file}:` : "";
    return o === n && !fo ? `${f}:${n}` : `${fo || f + ":"}${o} → ${fo ? f + ":" : ""}${n}`;
  };
  const card = (it: Item): HTMLElement => {
    if (it.el) return it.el;
    const c = it.c;
    const isViewed = viewed.has(it.key);
    it.collapsed = isViewed;
    const stat = h("span", { class: "df-stat" }, h("span", { class: "faint" }, "…"));
    const vb = button("Viewed", () => setViewed(it, !viewed.has(it.key)), { cls: "small df-viewed", icon: isViewed ? "check" : undefined, pressed: isViewed, title: "Mark as viewed (v)" });
    const toggle = () => setCollapsed(it, !it.collapsed);
    const ex = openHref(c);
    const head = h(
      "div",
      { class: "df-head" },
      h("button", { type: "button", class: "df-toggle", "aria-label": "Collapse", "aria-expanded": String(!isViewed), onClick: toggle }, icon("down")),
      stat,
      square(it.st),
      h("button", { type: "button", class: "df-qn", title: it.c.old && it.c.new && it.c.old.qname !== it.c.new.qname ? `was ${it.c.old.qname}` : undefined, onClick: toggle }, it.prefix ? h("span", { class: "faint" }, it.prefix) : null, it.local),
      h("span", { class: `badge k-${c.kind}` }, KIND_LABEL[c.kind]),
      c.impact === "breaking" ? h("span", { class: "badge danger" }, "breaking") : null,
      it.docsOnly ? h("span", { class: "badge" }, "docs only") : null,
      c.possiblyRenamed ? h("span", { class: "badge df-renamed" }, c.status === "removed" ? "renamed to " : "renamed from ", c.possiblyRenamed) : null,
      h("span", { class: "df-where", title: where(c) }, where(c)),
      h(
        "span",
        { class: "df-actions" },
        ex ? navLink(ex, () => (c.new ? ctx.go(c.new.id) : ctx.goRoute({ view: "old", id: c.old!.id })), "external", c.new ? `Open in the explorer (${cmp.newTitle})` : `Open in the explorer (${cmp.oldTitle})`) : null,
        navLink(diffHref(ctx, c), () => ctx.goRoute({ view: "diffc", query: it.key }), "columns", "Open the page of this change: diagram, tree and both versions"),
        vb
      )
    );
    const body = h("div", { class: "df-body" });
    const el = h("section", { class: "df-card" + (isViewed ? " collapsed" : ""), id: it.dom, "aria-label": qnameOf(c) }, head, body);
    Object.assign(it, { el, body, stat, viewBtn: vb });
    return el;
  };

  const loadOf = (it: Item): Promise<Source | string> => {
    if (it.src) return it.src;
    const c = it.c;
    const one = (which: Which, id: number | undefined) => (id === undefined ? Promise.resolve(null) : loadSource(versionCtx(ctx, cmp, which), id, which === "old" ? cmp.oldTitle : cmp.newTitle));
    it.src = Promise.all([one("old", c.old?.id), one("new", c.new?.id)]).then(([ra, rb]) => {
      const problems = [ra, rb].filter((x): x is string => typeof x === "string");
      const a = ra && typeof ra === "object" ? ra : null;
      const b = rb && typeof rb === "object" ? rb : null;
      if (!a && !b) return problems[0] ?? "No source is known for it.";
      const s: Source = { a, b, d: lineDiff(a, b), problems };
      it.srcDone = s;
      it.stat?.replaceChildren(h("span", { class: "d-added-text" }, `+${s.d.added}`), h("span", { class: "d-removed-text" }, `−${s.d.removed}`), blocks(s.d.added, s.d.removed));
      it.stat?.setAttribute("title", `${plural(s.d.added, "line")} added, ${plural(s.d.removed, "line")} removed`);
      return s;
    });
    return it.src;
  };

  const drawDiff = (it: Item, host: HTMLElement, s: Source) => {
    const ann = annotate(it.c, s);
    const note = (sd: "a" | "b", i: number) => {
      const list = ann[sd].get(i);
      return list ? h("div", { class: "df-notes" }, list.map((ch) => h("div", { class: `df-note ${ch.impact}` }, changeText(ch)))) : null;
    };
    const table = diffTable(s.a, s.b, s.d, { unified: unifiedNow() || it.c.status !== "changed", context: 3, hunkLabel: it.c.status === "changed" ? qnameOf(it.c) : undefined, note });
    host.replaceChildren(...s.problems.map((p) => h("p", { class: "muted small df-problem" }, p)), h("div", { class: "df-scroll" }, table));
  };

  const fill = (it: Item) => {
    if (it.filled || !it.body) return;
    it.filled = true;
    const c = it.c;
    const ch = c.changes ?? [];
    if (ch.length) {
      const nb = ch.filter((x) => x.impact === "breaking").length;
      it.body.append(h("details", { class: "df-sem", open: true }, h("summary", null, icon("down"), plural(ch.length, "semantic change"), nb ? h("span", { class: "df-imp breaking" }, ` · ${nb} breaking`) : null), h("ul", null, ch.map((x) => h("li", null, changeText(x))))));
    } else if (c.status === "removed") {
      it.body.append(h("div", { class: "df-sem" }, h("span", { class: "df-imp breaking" }, "Breaking"), " Documents that use ", h("code", null, qnameOf(c)), " are no longer valid.", c.possiblyRenamed ? [" It looks like it was renamed to ", h("code", null, c.possiblyRenamed), "."] : null));
    }
    const host = h("div", { class: "df-diff" }, h("p", { class: "faint small df-problem" }, "Loading…"));
    it.body.append(host);
    void loadOf(it).then((s) => {
      if (typeof s === "string") {
        host.replaceChildren(h("p", { class: "muted small df-problem" }, s));
        return;
      }
      const lines = Math.max(s.a?.lines.length ?? 0, s.b?.lines.length ?? 0);
      if ((it.docsOnly || (c.status !== "changed" && lines > LONG)) && !it.forced) {
        host.replaceChildren(h("div", { class: "df-load" }, h("span", null, it.docsOnly ? "Only the documentation changed, so this diff is hidden." : `${plural(lines, "line")}, all ${c.status === "added" ? "new" : "removed"}. Long diffs are hidden.`), button("Load diff", () => {
          it.forced = true;
          drawDiff(it, host, s);
        }, { cls: "small" })));
      } else drawDiff(it, host, s);
    });
  };
  const redraw = (it: Item) => {
    const host = it.body?.querySelector<HTMLElement>(".df-diff");
    if (host && it.srcDone && host.querySelector("table")) drawDiff(it, host, it.srcDone);
  };

  const setCollapsed = (it: Item, v: boolean) => {
    it.collapsed = v;
    it.el?.classList.toggle("collapsed", v);
    it.el?.querySelector(".df-toggle")?.setAttribute("aria-expanded", String(!v));
    if (!v) fill(it);
  };
  const leafOf = (it: Item) => tree.querySelector<HTMLElement>(`[data-dom="${it.dom}"]`);
  const setViewed = (it: Item, v: boolean) => {
    if (v) viewed.add(it.key);
    else viewed.delete(it.key);
    storeSet(vkey, [...viewed]);
    if (it.viewBtn) {
      it.viewBtn.setAttribute("aria-pressed", String(v));
      it.viewBtn.replaceChildren(...(v ? [icon("check")] : []), h("span", null, "Viewed"));
    }
    if (v && !it.collapsed) {
      setCollapsed(it, true);
      const r = it.el!.getBoundingClientRect();
      if (scroller && r.top < rootTop() + barH()) it.el!.scrollIntoView({ block: "start" });
    }
    const leaf = leafOf(it);
    leaf?.classList.toggle("viewed", v);
    const tick = leaf?.querySelector(".df-tick");
    if (tick) tick.replaceChildren(...(v ? [icon("check")] : []));
    progress();
  };
  const progress = () => {
    const n = items.filter((it) => viewed.has(it.key)).length;
    vText.textContent = `${n.toLocaleString()} / ${items.length.toLocaleString()} viewed`;
    vBar.style.width = `${items.length ? (n / items.length) * 100 : 0}%`;
  };

  // ---- filtering ---------------------------------------------------------------
  let shown: Item[] = [];
  const visible = () => {
    const needle = state.q.trim().toLowerCase();
    return items.filter((it) => {
      const c = it.c;
      const s = state.show;
      if (s === "breaking" ? c.impact !== "breaking" : s === "unviewed" ? viewed.has(it.key) : s !== "all" && c.status !== s) return false;
      if (state.k && KIND_SLUG[c.kind] !== state.k) return false;
      if (!state.docs && it.docsOnly) return false;
      return !needle || qnameOf(c).toLowerCase().includes(needle) || (c.old?.qname ?? "").toLowerCase().includes(needle);
    });
  };
  let io: IntersectionObserver | null = null;
  const build = () => {
    const vis = visible();
    const byFile = new Map<string, Item[]>();
    for (const it of vis) {
      if (!byFile.has(it.file)) byFile.set(it.file, []);
      byFile.get(it.file)!.push(it);
    }
    shown = [];
    tree.replaceChildren();
    cards.replaceChildren();
    for (const f of [...byFile.keys()].sort()) {
      const list = byFile.get(f)!.sort((x, y) => x.local.localeCompare(y.local));
      const n = { added: 0, removed: 0, changed: 0 };
      list.forEach((it) => n[it.c.status]++);
      const closed = closedFiles.has(f);
      const ul = h("ul", { hidden: closed });
      const folder = h("button", { type: "button", class: "df-folder", "aria-expanded": String(!closed), onClick: () => {
        const open = folder.getAttribute("aria-expanded") === "true";
        folder.setAttribute("aria-expanded", String(!open));
        ul.hidden = open;
        if (open) closedFiles.add(f);
        else closedFiles.delete(f);
      } }, icon("down"), h("span", { class: "df-fname", title: f }, f), h("span", { class: "df-fstat" }, n.added ? h("span", { class: "d-added-text" }, `+${n.added} `) : null, n.removed ? h("span", { class: "d-removed-text" }, `−${n.removed} `) : null, n.changed ? h("span", { class: "d-changed-text" }, `~${n.changed}`) : null));
      for (const it of list) {
        const isViewed = viewed.has(it.key);
        ul.append(h("li", null, h("a", { class: "df-leaf" + (isViewed ? " viewed" : ""), href: diffHref(ctx, it.c), "data-dom": it.dom, title: `${qnameOf(it.c)} (${KIND_LABEL[it.c.kind].toLowerCase()})`, onClick: (ev: Event) => {
          const me = ev as MouseEvent;
          if (me.metaKey || me.ctrlKey || me.shiftKey) return;
          ev.preventDefault();
          go(it);
          if (!wide()) toggleNav(false);
        } }, square(it.st), h("span", { class: "df-lname" }, it.local), it.c.impact === "breaking" ? h("span", { class: "df-dot", title: "Breaking" }) : null, h("span", { class: "df-tick", "aria-hidden": "true" }, isViewed ? icon("check") : null))));
        cards.append(card(it));
        shown.push(it);
      }
      tree.append(folder, ul);
    }
    if (!vis.length) {
      cards.append(h("div", { class: "df-empty" }, "No changed component matches these filters."));
      tree.append(h("p", { class: "faint small df-empty-tree" }, "Nothing matches."));
    }
    tabCount.textContent = vis.length === items.length ? items.length.toLocaleString() : `${vis.length.toLocaleString()} / ${items.length.toLocaleString()}`;
    progress();
    current = null;
    observe();
    spy();
  };

  // ---- scrolling: lazy card bodies, the tree follows the card at the top -------------
  let scroller: HTMLElement | null = null;
  /** The window scrolls when the page is not inside a scrolling element. */
  const isDoc = () => scroller === document.scrollingElement;
  const rootTop = () => (!scroller || isDoc() ? 0 : scroller.getBoundingClientRect().top);
  const barH = () => toolbar.offsetHeight;
  const observe = () => {
    if (!scroller) return;
    io?.disconnect();
    io = new IntersectionObserver((es) => {
      for (const e of es) {
        if (!e.isIntersecting) continue;
        const it = shown.find((x) => x.el === e.target);
        if (!it) continue;
        void loadOf(it);
        if (!it.collapsed) fill(it);
        io?.unobserve(e.target);
      }
    }, { root: isDoc() ? null : scroller, rootMargin: "1200px 0px" });
    shown.forEach((it) => io!.observe(it.el!));
  };
  let current: Item | null = null;
  const spy = () => {
    if (!scroller) return;
    const y = rootTop() + barH() + 40;
    let best: Item | null = null;
    for (const it of shown) {
      if (it.el!.getBoundingClientRect().top <= y) best = it;
      else break;
    }
    best = best ?? shown[0] ?? null;
    if (best === current) return;
    current?.el?.classList.remove("on");
    tree.querySelectorAll(".df-leaf.on").forEach((x) => x.classList.remove("on"));
    current = best;
    if (!best) return;
    best.el?.classList.add("on");
    const leaf = leafOf(best);
    if (leaf) {
      leaf.classList.add("on");
      const lr = leaf.getBoundingClientRect();
      const tr = tree.getBoundingClientRect();
      if (lr.top < tr.top || lr.bottom > tr.bottom) tree.scrollTop += lr.top < tr.top ? lr.top - tr.top - 8 : lr.bottom - tr.bottom + 8;
    }
    if (ctx.route.params.at !== best.key && (scroller.scrollTop > 0 || ctx.route.params.at)) ctx.setParams({ at: best.key });
  };
  const go = (it: Item) => {
    if (it.collapsed) setCollapsed(it, false);
    fill(it);
    it.el?.scrollIntoView({ block: "start" });
  };

  // ---- controls --------------------------------------------------------------------
  const rebuild = () => {
    save();
    build();
  };
  showSel.addEventListener("change", () => {
    state.show = showSel.value as Show;
    rebuild();
  });
  kindSel.addEventListener("change", () => {
    state.k = kindSel.value;
    rebuild();
  });
  docsBox.addEventListener("change", () => {
    state.docs = !docsBox.checked;
    rebuild();
  });
  let qt: ReturnType<typeof setTimeout> | undefined;
  search.addEventListener("input", () => {
    clearTimeout(qt);
    qt = setTimeout(() => {
      state.q = search.value;
      rebuild();
    }, 150);
  });
  const setMode = (u: boolean) => {
    state.unified = u;
    splitBtn.setAttribute("aria-pressed", String(!u));
    uniBtn.setAttribute("aria-pressed", String(u));
    save();
    items.forEach(redraw);
  };
  let drawerOpen = false;
  const toggleNav = (v?: boolean) => {
    if (wide()) {
      state.nav = v ?? !state.nav;
      save();
    } else drawerOpen = v ?? !drawerOpen;
    applyNav();
  };
  const applyNav = () => {
    const open = wide() ? state.nav : drawerOpen;
    shell.classList.toggle("nav-hidden", wide() && !state.nav);
    shell.classList.toggle("nav-open", !wide() && drawerOpen);
    navBtn.setAttribute("aria-pressed", String(open));
  };
  applyNav();

  const onKey = (ev: KeyboardEvent) => {
    if (!page.isConnected) {
      window.removeEventListener("keydown", onKey);
      return;
    }
    const target = ev.composedPath()[0] as HTMLElement | undefined;
    if (ev.metaKey || ev.ctrlKey || ev.altKey || (target && (target.closest?.("input, select, textarea, [contenteditable]") || target.isContentEditable))) return;
    const i = current ? shown.indexOf(current) : -1;
    if (ev.key === "j" && shown[i + 1]) go(shown[i + 1]);
    else if (ev.key === "k" && shown[i - 1]) go(shown[i - 1]);
    else if (ev.key === "v" && current) setViewed(current, !viewed.has(current.key));
    else if (ev.key === "t") toggleNav();
    else if (ev.key === "s" && window.innerWidth >= NARROW) setMode(!state.unified);
    else if (ev.key === "/") {
      if (!wide() && !drawerOpen) toggleNav(true);
      search.focus();
    } else return;
    ev.preventDefault();
    ev.stopPropagation();
  };
  window.addEventListener("keydown", onKey);

  build();
  // Wire the scrolling once the page is in place: the app scrolls its main area, not the window.
  whenVisible(page, () => {
    scroller = scrollParent(page);
    if (!scroller) return;
    let raf = 0;
    (isDoc() ? window : scroller).addEventListener("scroll", () => {
      if (!raf) raf = requestAnimationFrame(() => {
        raf = 0;
        spy();
      });
    }, { passive: true });
    const sizes = () => {
      page.style.setProperty("--df-bar", `${barH()}px`);
      page.style.setProperty("--df-view", `${isDoc() ? window.innerHeight : scroller!.clientHeight}px`);
      applyNav();
    };
    new ResizeObserver(sizes).observe(toolbar);
    new ResizeObserver(sizes).observe(scroller);
    sizes();
    observe();
    const at = P.at ? shown.find((it) => it.key === P.at) : undefined;
    if (at) go(at);
    else spy();
  });
  return page;
}

function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if (o === "auto" || o === "scroll") return p;
  }
  return document.scrollingElement as HTMLElement | null;
}
