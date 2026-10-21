// The left panel: search, and lists of types, elements, groups and files.
// Lists are virtualised: only the rows on screen exist, so thousands of
// types (NeTEx has about 2,600 complex types) scroll smoothly.
import type { AppCtx } from "../ctx";
import { debounce, h, icon, plural } from "../dom";
import { KIND_LABEL, type Id } from "../model";

type Tab = "complexType" | "simpleType" | "element" | "groups" | "files";

export interface Sidebar {
  el: HTMLElement;
  /** Highlight the selected component and scroll it into view. */
  select(id: Id | undefined, file?: number): void;
  focusSearch(): void;
}

const ROW = 30;

interface Item {
  id?: Id;
  file?: number;
  text: string;
  sub?: string;
  kind: string;
  title?: string;
}

/** A list that renders only the visible rows. */
class VList {
  readonly el: HTMLElement;
  private inner: HTMLElement;
  private items: Item[] = [];
  private selected: (it: Item) => boolean = () => false;
  private active = -1;
  private raf = 0;

  constructor(private ctx: AppCtx) {
    this.inner = h("div", { class: "vinner" });
    this.el = h("div", { class: "vlist", role: "listbox" }, this.inner);
    this.el.addEventListener("scroll", () => {
      cancelAnimationFrame(this.raf);
      this.raf = requestAnimationFrame(() => this.paint());
    });
    new ResizeObserver(() => this.paint()).observe(this.el);
  }

  set(items: Item[], selected: (it: Item) => boolean): void {
    this.items = items;
    this.selected = selected;
    this.active = -1;
    this.inner.style.height = `${items.length * ROW}px`;
    this.el.scrollTop = 0;
    this.paint();
  }

  get length(): number {
    return this.items.length;
  }

  setSelected(selected: (it: Item) => boolean): void {
    this.selected = selected;
    this.paint();
  }

  /** Scroll so that the first item matching `pred` is visible. */
  reveal(pred: (it: Item) => boolean): void {
    const i = this.items.findIndex(pred);
    if (i < 0) return;
    const top = i * ROW;
    if (top < this.el.scrollTop || top + ROW > this.el.scrollTop + this.el.clientHeight) this.el.scrollTop = top - this.el.clientHeight / 2;
    this.paint();
  }

  move(delta: number): void {
    if (!this.items.length) return;
    this.active = (this.active + delta + this.items.length) % this.items.length;
    this.reveal((it) => it === this.items[this.active]);
  }

  activeItem(): Item | undefined {
    return this.items[this.active >= 0 ? this.active : 0];
  }

  paint(): void {
    const h0 = this.el.clientHeight || 600;
    const first = Math.max(0, Math.floor(this.el.scrollTop / ROW) - 8);
    const last = Math.min(this.items.length, Math.ceil((this.el.scrollTop + h0) / ROW) + 8);
    const rows: HTMLElement[] = [];
    for (let i = first; i < last; i++) {
      const it = this.items[i];
      const href = it.id !== undefined ? this.ctx.href(it.id) : this.ctx.hrefRoute({ view: "file", id: it.file });
      const a = h(
        "a",
        { class: `row vrow${this.selected(it) ? " selected" : ""}${i === this.active ? " active" : ""}`, href, title: it.title ?? it.text, style: { top: `${i * ROW}px` }, onClick: ((ev: MouseEvent) => {
          if (ev.metaKey || ev.ctrlKey || ev.shiftKey) return;
          ev.preventDefault();
          if (it.id !== undefined) this.ctx.go(it.id);
          else this.ctx.goRoute({ view: "file", id: it.file });
        }) as EventListener },
        h("span", { class: `kind-dot k-${it.kind}` }),
        h("span", { class: "lbl" }, it.text),
        it.sub ? h("span", { class: "ctx" }, it.sub) : null
      );
      rows.push(a);
    }
    this.inner.replaceChildren(...rows);
  }
}

export function sidebar(ctx: AppCtx): Sidebar {
  const m = ctx.m;
  const el = h("div", { class: "sidebar" });
  const input = h("input", { class: "input", type: "search", placeholder: "Search names and documentation…", "aria-label": "Search", autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
  const kbd = h("kbd", null, "/");
  const box = h("div", { class: "search-box" }, icon("search"), input, kbd);
  const tabs = h("div", { class: "tabs", role: "tablist" });
  const nsList = m.b.namespaces.map((n, i) => ({ i, n, count: 0 }));
  for (const k of ["complexType", "simpleType", "element", "group", "attributeGroup"] as const) for (const id of m.lists[k]) if (m.c[id].ns !== undefined) nsList[m.c[id].ns!].count++;
  const usedNs = nsList.filter((x) => x.count > 0 && x.n.uri !== "http://www.w3.org/2001/XMLSchema");
  let nsFilter: number | undefined;
  try {
    const saved = localStorage.getItem("se.ns");
    if (saved !== null && usedNs.some((x) => String(x.i) === saved)) nsFilter = Number(saved);
  } catch {
    /* no storage */
  }
  const nsSel = h("select", { class: "input ns-select", "aria-label": "Namespace", title: "Show one namespace" }, h("option", { value: "" }, "All namespaces"), usedNs.map((x) => h("option", { value: String(x.i), title: x.n.uri }, `${x.n.prefix} · ${x.count}`))) as HTMLSelectElement;
  nsSel.value = nsFilter === undefined ? "" : String(nsFilter);
  const info = h("div", { class: "list-info faint" });
  const list = new VList(ctx);
  el.append(box, tabs, ...(usedNs.length > 1 ? [nsSel] : []), info, list.el);

  const groupsCount = m.lists.group.length + m.lists.attributeGroup.length + m.lists.attribute.length;
  const tabDefs: { id: Tab; label: string; count: number; title: string }[] = [
    { id: "complexType", label: "Types", count: m.lists.complexType.length, title: "Complex types" },
    { id: "simpleType", label: "Simple", count: m.lists.simpleType.length, title: "Simple types" },
    { id: "element", label: "Elements", count: m.lists.element.length, title: "Global elements" },
    { id: "groups", label: "Groups", count: groupsCount, title: "Groups, attribute groups and global attributes" },
    { id: "files", label: "Files", count: m.b.files.length, title: "Schema files" },
  ];
  let tab: Tab = "complexType";
  try {
    const saved = localStorage.getItem("se.tab") as Tab | null;
    if (saved && tabDefs.some((t) => t.id === saved && t.count)) tab = saved;
  } catch {
    /* no storage */
  }
  const setTab = (t: Tab) => {
    tab = t;
    try {
      localStorage.setItem("se.tab", t);
    } catch {
      /* ignore */
    }
    tabs.querySelectorAll("button").forEach((x) => x.setAttribute("aria-selected", String((x as HTMLElement).dataset.tab === t)));
    render();
  };
  for (const t of tabDefs) {
    if (!t.count) continue;
    tabs.appendChild(h("button", { type: "button", role: "tab", title: t.title, dataset: { tab: t.id }, "aria-selected": String(t.id === tab), onClick: () => setTab(t.id) }, t.label, h("span", { class: "count" }, t.count.toLocaleString())));
  }

  let selected: Id | undefined;
  let selectedFile: number | undefined;
  const isSel = (it: Item) => (it.id !== undefined ? it.id === selected : it.file === selectedFile);
  const multiNs = usedNs.length > 1;
  const item = (id: Id): Item => {
    const c = m.c[id];
    return { id, text: c.parent === undefined ? c.name ?? "" : m.label(id), sub: c.parent !== undefined ? m.label(m.owner(id)) : multiNs ? m.prefix(c.ns) : undefined, kind: c.kind, title: `${m.qname(id) || m.label(id)} · ${KIND_LABEL[c.kind]}${m.fileName(id) ? "\n" + m.fileName(id) : ""}` };
  };
  const byNs = (ids: Id[]) => (nsFilter === undefined ? ids : ids.filter((id) => m.c[id].ns === nsFilter));

  const render = () => {
    const q = input.value.trim();
    kbd.hidden = q.length > 0;
    if (q) {
      const hits = byNs(m.search(q, 500));
      info.textContent = hits.length >= 500 ? "First 500 matches" : plural(hits.length, "match", "matches");
      list.set(hits.map(item), isSel);
      return;
    }
    let ids: Id[];
    if (tab === "files") {
      const files = m.b.files.map((f, i) => ({ f, i })).filter(({ f }) => nsFilter === undefined || f.namespace === nsFilter);
      info.textContent = plural(files.length, "file");
      list.set(files.map(({ f, i }) => ({ file: i, text: f.name, sub: f.components ? String(f.components) : undefined, kind: "file", title: `${f.name}\n${f.targetNamespace ?? "no namespace"}` })), isSel);
      return;
    }
    if (tab === "groups") ids = [...m.lists.group, ...m.lists.attributeGroup, ...m.lists.attribute];
    else ids = m.lists[tab];
    ids = byNs(ids);
    info.textContent = `${plural(ids.length, tab === "groups" ? "group or attribute" : KIND_LABEL[tab].toLowerCase(), tab === "groups" ? "groups and attributes" : undefined)}${nsFilter !== undefined ? ` in ${m.prefix(nsFilter)}` : ""}`;
    list.set(ids.map(item), isSel);
  };
  nsSel.addEventListener("change", () => {
    nsFilter = nsSel.value === "" ? undefined : Number(nsSel.value);
    try {
      localStorage.setItem("se.ns", nsSel.value);
    } catch {
      /* ignore */
    }
    render();
  });
  input.addEventListener("input", debounce(render, 90));
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      list.move(ev.key === "ArrowDown" ? 1 : -1);
    } else if (ev.key === "Enter") {
      const it = list.activeItem();
      if (it?.id !== undefined) ctx.go(it.id);
    } else if (ev.key === "Escape") {
      input.value = "";
      render();
      input.blur();
    }
  });
  render();

  return {
    el,
    select(id, file) {
      selected = id;
      selectedFile = file;
      if (!input.value.trim()) {
        const kind = id !== undefined ? m.c[id].kind : undefined;
        const want: Tab | undefined = file !== undefined ? "files" : id === undefined || m.c[id].parent !== undefined ? undefined : kind === "complexType" || kind === "simpleType" || kind === "element" ? kind : kind === "group" || kind === "attributeGroup" || kind === "attribute" ? "groups" : undefined;
        if (want && want !== tab) setTab(want);
      }
      list.setSelected(isSel);
      list.reveal(isSel);
    },
    focusSearch() {
      input.focus();
      input.select();
    },
  };
}
