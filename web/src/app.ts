// The application: state, routing, the shell around the views.
import type { AppCtx, Prefs, Route } from "./ctx";
import { button, copyText, h, icon, type Child } from "./dom";
import { fetchBundleFromServer, indexFiles, loadUrl, memorySources, readDataTransfer, readFiles, serverSources, serverStatus, urlSources, type LoadProgress, type NamedBytes, type ServerStatus, type SourceProvider } from "./loader";
import { KIND_SLUG, Model, type Bundle, type Id } from "./model";
import { matdataMark } from "./logo";
import { openAbout, openHelp } from "./views/dialogs";
import { homePage } from "./views/home";
import { overviewPage } from "./views/overview";
import { componentPage, filePage } from "./views/pages";
import { sidebar, type Sidebar } from "./views/sidebar";

export interface AppOptions {
  /** Route through location.hash (standalone app) or keep routes internal (embedded component). */
  routing: boolean;
  embed: boolean;
  theme?: Prefs["theme"];
  onNavigate?: (name: string | null, route: Route) => void;
  onLoaded?: (bundle: Bundle) => void;
  onError?: (err: Error) => void;
  /** Where example bundles are listed (a JSON file next to the app). */
  examplesUrl?: string;
  /** Hide the sidebar and top bar; show only the page. */
  minimal?: boolean;
}

const DEFAULT_PREFS: Prefs = {
  theme: "auto",
  showInherited: true,
  depth: 1,
  direction: "DOWN",
  enums: true,
  incoming: true,
};

interface Example {
  id?: string;
  title: string;
  src: string;
  sources?: string;
  description?: string;
  focus?: string;
  publisher?: string;
  licence?: string;
}

export class App implements AppCtx {
  readonly root: HTMLElement;
  private opts: AppOptions;
  private shellEl: HTMLElement;
  private mainEl: HTMLElement;
  private topbar: HTMLElement;
  private side: Sidebar | null = null;
  private bodyEl: HTMLElement;
  private model: Model | null = null;
  private _route: Route = { view: "home", params: {} };
  private _prefs: Prefs;
  private server: ServerStatus | null = null;
  private toastEl: HTMLElement | null = null;
  /** Where the schemas came from: a URL (shareable), local files, or the server. */
  private source: { kind: "url"; url: string; sources?: string } | { kind: "files" } | { kind: "server" } | null = null;
  private sources: SourceProvider | null = null;
  private sourceCache = new Map<number, Promise<string | null>>();
  private onHash = () => this.readHash();

  constructor(root: HTMLElement, opts: AppOptions) {
    this.root = root;
    this.opts = opts;
    this._prefs = { ...DEFAULT_PREFS, ...loadPrefs() };
    if (opts.theme) this._prefs.theme = opts.theme;
    this.topbar = h("div", { class: "topbar" });
    this.mainEl = h("div", { class: "main" }, h("div", { class: "main-inner" }));
    this.bodyEl = h("div", { class: "body no-sidebar" }, this.mainEl);
    this.shellEl = h("div", { class: `shell${opts.embed ? " embed" : ""}` }, opts.minimal ? null : this.topbar, this.bodyEl);
    root.appendChild(this.shellEl);
    this.applyTheme();
    if (opts.routing) window.addEventListener("hashchange", this.onHash);
    root.addEventListener("keydown", (ev) => {
      if (ev.key === "/" && !(ev.target instanceof HTMLInputElement) && !(ev.target instanceof HTMLTextAreaElement)) {
        ev.preventDefault();
        this.side?.focusSearch();
      }
    });
    this.wireDrop();
  }

  destroy(): void {
    window.removeEventListener("hashchange", this.onHash);
  }

  // ---- AppCtx -------------------------------------------------------------
  get m(): Model {
    if (!this.model) throw new Error("nothing loaded");
    return this.model;
  }
  get route(): Route {
    return this._route;
  }
  get prefs(): Prefs {
    return this._prefs;
  }
  get embed(): boolean {
    return this.opts.embed;
  }
  get bundle(): Bundle | null {
    return this.model?.b ?? null;
  }

  go(id: Id, extra: Partial<Route> = {}): void {
    this.goRoute({ view: "comp", id, tab: extra.tab, params: extra.params ?? {} });
  }

  goRoute(r: Partial<Route>): void {
    const route: Route = { view: r.view ?? "home", id: r.id, tab: r.tab, query: r.query, params: r.params ?? {} };
    if (this.opts.routing) {
      const hash = this.hashFor(route);
      if (location.hash !== hash) {
        location.hash = hash; // hashchange → readHash → render
        return;
      }
    }
    this.setRoute(route);
  }

  href(id: Id, extra: Partial<Route> = {}): string {
    return this.hrefRoute({ view: "comp", id, tab: extra.tab, params: extra.params });
  }

  hrefRoute(r: Partial<Route>): string {
    return this.hashFor({ view: r.view ?? "home", id: r.id, tab: r.tab, query: r.query, params: r.params ?? {} });
  }

  setPrefs(p: Partial<Prefs>): void {
    Object.assign(this._prefs, p);
    savePrefs(this._prefs);
    if (p.theme !== undefined) this.applyTheme();
  }

  setParams(p: Record<string, string | undefined>): void {
    const params = { ...this._route.params };
    for (const [k, v] of Object.entries(p)) {
      if (v === undefined || v === "") delete params[k];
      else params[k] = v;
    }
    this._route = { ...this._route, params };
    if (this.opts.routing) history.replaceState(history.state, "", this.hashFor(this._route));
  }

  shareLink(): { url: string; complete: boolean } {
    const u = new URL(location.href);
    u.hash = this.hashFor(this._route);
    u.searchParams.delete("src");
    if (this.source?.kind === "url") {
      u.searchParams.set("bundle", this.source.url);
      if (this.source.sources) u.searchParams.set("sources", this.source.sources);
      else u.searchParams.delete("sources");
    } else {
      u.searchParams.delete("bundle");
      u.searchParams.delete("sources");
    }
    return { url: u.toString(), complete: this.source?.kind !== "files" };
  }

  private async share(): Promise<void> {
    const { url, complete } = this.shareLink();
    const ok = await copyText(url);
    if (!ok) {
      window.prompt("Copy this link", url);
      return;
    }
    this.toast(complete ? "Link to this view copied" : "Link copied. It opens this view only where the same files are loaded: files from your computer are not part of it.");
  }

  toast(msg: string): void {
    this.toastEl?.remove();
    this.toastEl = h("div", { class: "toast" }, msg);
    this.shellEl.appendChild(this.toastEl);
    setTimeout(() => this.toastEl?.remove(), msg.length > 60 ? 5000 : 2200);
  }

  refresh(): void {
    const top = this.mainEl.scrollTop;
    this.render();
    this.mainEl.scrollTop = top;
  }

  sourceText(file: number): Promise<string | null> {
    if (!this.sources || !this.model) return Promise.resolve(null);
    let p = this.sourceCache.get(file);
    if (!p) {
      p = this.sources(file, this.model.b.files[file]?.name ?? "");
      this.sourceCache.set(file, p);
    }
    return p;
  }

  // ---- routing ------------------------------------------------------------
  private hashFor(r: Route): string {
    const q = new URLSearchParams();
    if (r.tab) q.set("tab", r.tab);
    for (const [k, v] of Object.entries(r.params)) if (v) q.set(k, v);
    const qs = q.toString();
    let path = "#/";
    if (r.view === "comp" && r.id !== undefined && this.model) {
      const c = this.model.comp(r.id);
      path = c.parent === undefined && c.name ? `#/${KIND_SLUG[c.kind]}/${encodeURIComponent(this.model.qname(r.id))}` : `#/id/${r.id}`;
    } else if (r.view === "file" && r.id !== undefined) path = `#/file/${r.id}`;
    else if (r.view !== "home") path = "#/" + r.view;
    return path + (qs ? "?" + qs : "");
  }

  private parseHash(hash: string): Route {
    const [path, qs] = hash.replace(/^#/, "").split("?");
    const params: Record<string, string> = {};
    let tab: string | undefined;
    for (const [k, v] of new URLSearchParams(qs ?? "")) {
      if (k === "tab") tab = v;
      else params[k] = v;
    }
    const parts = path.split("/").filter(Boolean);
    const m = this.model;
    if (!m) return { view: "home", params };
    if (parts[0] === "overview") return { view: "overview", params };
    if (parts[0] === "file" && parts[1] !== undefined) {
      const n = Number(parts[1]);
      if (Number.isInteger(n) && m.b.files[n]) return { view: "file", id: n, params };
    }
    if (parts[0] === "id" && parts[1] !== undefined) {
      const n = Number(parts[1]);
      if (Number.isInteger(n) && m.c[n]) return { view: "comp", id: n, tab, params };
    }
    if (parts.length >= 2) {
      const qn = decodeURIComponent(parts.slice(1).join("/"));
      const id = m.find(parts[0], qn);
      if (id !== undefined) return { view: "comp", id, tab, params };
      return { view: "missing", query: qn, params };
    }
    return { view: "home", params };
  }

  readHash(): void {
    if (!this.model) return;
    this.setRoute(this.parseHash(location.hash));
  }

  private setRoute(r: Route): void {
    this._route = r;
    this.render();
    const name = r.view === "comp" && r.id !== undefined && this.model ? this.model.qname(r.id) : null;
    this.opts.onNavigate?.(name, r);
  }

  /** Public: open a global component by `kind/prefix:name` or `prefix:name`. */
  goTo(name: string, tab?: string): boolean {
    if (!this.model) return false;
    const m = this.model;
    let id: Id | undefined;
    const slash = name.indexOf("/");
    if (slash > 0) id = m.find(name.slice(0, slash), name.slice(slash + 1));
    for (const k of ["ct", "el", "st", "gr", "ag", "at"]) if (id === undefined) id = m.find(k, name);
    if (id === undefined) return false;
    this.go(id, { tab });
    return true;
  }

  // ---- loading ------------------------------------------------------------
  async start(src?: string | null, focus?: string | null, sources?: string | null): Promise<void> {
    this.server = await serverStatus();
    if (src) {
      await this.openUrl(src, focus ?? undefined, sources ?? undefined);
      return;
    }
    if (this.server?.loaded) {
      try {
        this.showProgress({ stage: "download", detail: "the schemas from the server" });
        const b = await fetchBundleFromServer((p) => this.showProgress(p));
        if (this.server.title) b.title = this.server.title;
        this.source = { kind: "server" };
        this.sources = serverSources();
        this.setBundle(b);
        if (focus) this.goTo(focus);
        return;
      } catch (e) {
        this.showError(e as Error);
        return;
      }
    }
    this.showOpen();
  }

  async openUrl(url: string, focus?: string, sources?: string): Promise<void> {
    try {
      this.showProgress({ stage: "download", detail: url });
      const b = await loadUrl(url, (p) => this.showProgress(p));
      this.source = { kind: "url", url, sources };
      const abs = new URL(url, document.baseURI).href;
      this.sources = urlSources(sources ? new URL(sources, document.baseURI).href : abs);
      if (this.opts.routing) {
        const u = new URL(location.href);
        u.searchParams.delete("src");
        u.searchParams.set("bundle", url);
        if (sources) u.searchParams.set("sources", sources);
        else u.searchParams.delete("sources");
        history.replaceState(history.state, "", u.toString());
      }
      this.setBundle(b);
      if (focus) this.goTo(focus);
    } catch (e) {
      this.showError(e as Error, () => this.showOpen());
      this.opts.onError?.(e as Error);
    }
  }

  async openFiles(files: NamedBytes[] | FileList | File[]): Promise<void> {
    try {
      const named = Array.isArray(files) && files.length && "bytes" in (files[0] as object) ? (files as NamedBytes[]) : await readFiles(files as FileList | File[]);
      if (this.opts.routing) {
        const u = new URL(location.href);
        for (const k of ["src", "bundle", "sources"]) u.searchParams.delete(k);
        history.replaceState(history.state, "", u.toString());
      }
      if (named.length === 0) throw new Error("none of the files is an XML Schema (.xsd) or a bundle (.json)");
      // A single bundle file loads directly.
      if (named.length === 1 && /\.json$/i.test(named[0].name)) {
        const b = JSON.parse(new TextDecoder().decode(named[0].bytes)) as Bundle;
        if (!b || !Array.isArray(b.components)) throw new Error("this JSON file is not a schema-explorer bundle");
        this.source = { kind: "files" };
        this.sources = null;
        this.setBundle(b);
        return;
      }
      const xsd = named.filter((f) => /\.xsd$/i.test(f.name));
      if (xsd.length === 0) throw new Error("no .xsd files among the files");
      // Folders keep their relative paths, so imports and includes resolve.
      this.showProgress({ stage: "index", detail: xsd.length === 1 ? xsd[0].name : `${xsd.length} files` });
      const started = performance.now();
      const b = await indexFiles(xsd, (p) => this.showProgress(p));
      // A dropped folder names the set.
      const top = new Set(xsd.map((f) => (f.name.includes("/") ? f.name.split("/")[0] : "")));
      if (top.size === 1 && !top.has("")) b.title = [...top][0];
      console.info(`indexed ${xsd.length} files in ${Math.round(performance.now() - started)} ms`);
      this.source = { kind: "files" };
      this.sources = memorySources(xsd);
      this.setBundle(b);
    } catch (e) {
      this.showError(e as Error, () => this.showOpen());
      this.opts.onError?.(e as Error);
    }
  }

  setBundle(b: Bundle): void {
    const t0 = performance.now();
    this.model = new Model(b);
    this.sourceCache.clear();
    this.rebuildSidebar();
    this.renderTopbar();
    console.info(`model ready in ${Math.round(performance.now() - t0)} ms: ${b.components.length} components`);
    this.opts.onLoaded?.(b);
    if (this.opts.routing) this.readHash();
    else this.goRoute({ view: "home" });
  }

  private rebuildSidebar(): void {
    this.side?.el.remove();
    this.side = null;
    if (!this.model || this.opts.minimal) {
      this.bodyEl.classList.add("no-sidebar");
      return;
    }
    this.side = sidebar(this);
    this.bodyEl.insertBefore(this.side.el, this.mainEl);
    this.bodyEl.classList.remove("no-sidebar");
  }

  // ---- rendering ----------------------------------------------------------
  private setMain(...children: Child[]): void {
    const inner = this.mainEl.firstElementChild as HTMLElement;
    inner.replaceChildren();
    for (const c of children) if (c) inner.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    this.mainEl.scrollTop = 0;
  }

  private render(): void {
    if (!this.model) return;
    const r = this._route;
    this.side?.select(r.view === "comp" ? r.id : undefined, r.view === "file" ? r.id : undefined);
    this.side?.el.classList.remove("open");
    let page: HTMLElement;
    const title = this.model.title;
    if (r.view === "comp" && r.id !== undefined) {
      page = componentPage(this, r.id);
      if (this.opts.routing) document.title = `${this.model.label(r.id)} · ${title}`;
    } else if (r.view === "file" && r.id !== undefined) {
      page = filePage(this, r.id);
      if (this.opts.routing) document.title = `${this.model.b.files[r.id]?.name} · ${title}`;
    } else if (r.view === "overview") {
      page = overviewPage(this);
      if (this.opts.routing) document.title = `Overview · ${title}`;
    } else if (r.view === "missing") {
      page = h("div", null, h("h1", null, "Not found"), h("p", null, "Nothing in the loaded schemas is called ", h("code", null, r.query ?? ""), "."), button("Back to the start", () => this.goRoute({ view: "home" })));
    } else {
      page = homePage(this);
      if (this.opts.routing) document.title = `${title} · schema-explorer`;
    }
    this.setMain(page, this.opts.minimal ? null : this.footer());
  }

  private footer(): HTMLElement {
    return h("div", { class: "about-foot" }, "schema-explorer · ", h("a", { href: "https://github.com/Matdata-eu/schema-explorer", target: "_blank", rel: "noopener" }, "source"), " · ", h("a", { href: "https://github.com/Matdata-eu/schema-explorer/issues", target: "_blank", rel: "noopener" }, "questions, bugs and feature requests"), " · ", h("a", { href: "#", onClick: (ev: Event) => {
      ev.preventDefault();
      this.about();
    } }, "about"));
  }

  private renderTopbar(): void {
    const t = this.topbar;
    t.replaceChildren();
    const m = this.model;
    if (m) t.appendChild(button("", () => this.side?.el.classList.toggle("open"), { icon: "menu", cls: "ghost icon-only menu-btn", title: "Types, elements and search" }));
    t.appendChild(h("a", { class: "title", href: this.hrefRoute({ view: "home" }), onClick: (ev: Event) => {
      ev.preventDefault();
      if (this.model) this.goRoute({ view: "home" });
      else this.showOpen();
    } }, matdataMark(), h("span", { class: "title-text" }, m?.title ?? "schema-explorer"), m ? h("small", { class: "hide-mobile" }, `${(m.b.stats.global.complexType ?? 0).toLocaleString()} complex types`) : null));
    t.appendChild(h("span", { class: "spacer" }));
    if (m) t.appendChild(button("Map", () => this.goRoute({ view: "overview" }), { icon: "map", cls: "small hide-mobile", title: "Overview map of the complex types" }));
    if (m) t.appendChild(button("Share", () => void this.share(), { icon: "share", cls: "small share-btn", title: "Copy a link to exactly this view" }));
    if (m) t.appendChild(button("Open…", () => this.showOpen(), { icon: "folder", cls: "small hide-mobile", title: "Load other schemas" }));
    const dark = this.isDark();
    t.appendChild(button("", () => this.setPrefs({ theme: this.isDark() ? "light" : "dark" }), { icon: dark ? "sun" : "moon", cls: "ghost icon-only", title: "Switch theme" }));
    t.appendChild(button("", () => openHelp(this.shellEl), { icon: "help", cls: "ghost icon-only", title: "Help" }));
    t.appendChild(button("", () => this.about(), { icon: "info", cls: "ghost icon-only about-btn", title: "About" }));
  }

  private isDark(): boolean {
    const t = this._prefs.theme;
    return t === "dark" || (t === "auto" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  }

  private applyTheme(): void {
    const host = this.root.getRootNode() instanceof ShadowRoot ? (this.root.getRootNode() as ShadowRoot).host : this.root;
    host.setAttribute("theme", this.isDark() ? "dark" : "light");
    this.renderTopbar();
    // Diagrams take their colours from the theme when drawn.
    if (this.model && this._route.view !== "home") this.refresh();
  }

  private about(): void {
    const lic = this.server ? new URL("licenses", document.baseURI).href : "https://github.com/Matdata-eu/schema-explorer/blob/main/THIRD_PARTY_NOTICES.md";
    openAbout(this.shellEl, { licensesUrl: lic, generator: this.model?.b.generator });
  }

  // ---- open / progress / errors --------------------------------------------
  showOpen(): void {
    const fileInput = h("input", { type: "file", multiple: true, accept: ".xsd,.json", hidden: true, onChange: (ev: Event) => {
      const files = (ev.target as HTMLInputElement).files;
      if (files?.length) void this.openFiles(files);
    } }) as HTMLInputElement;
    const dirInput = h("input", { type: "file", multiple: true, hidden: true, webkitdirectory: true, onChange: (ev: Event) => {
      const files = (ev.target as HTMLInputElement).files;
      if (files?.length) void this.openFiles(files);
    } }) as HTMLInputElement;
    const drop = h(
      "div",
      { class: "dropzone" },
      icon("folder", "drop-icon"),
      h("p", null, h("strong", null, "Drop .xsd files or folders here"), h("br"), "or ", h("button", { type: "button", class: "linkish", onClick: () => fileInput.click() }, "choose files"), " · ", h("button", { type: "button", class: "linkish", onClick: () => dirInput.click() }, "choose a folder")),
      h("p", { class: "muted small" }, "Include the files the schema imports and includes. A bundle made with ", h("code", null, "schema-explorer index"), " (.json) works too."),
      fileInput,
      dirInput
    );
    drop.addEventListener("click", (ev) => {
      if (ev.target === drop) fileInput.click();
    });
    const urlInput = h("input", { class: "input", type: "url", placeholder: "https://example.org/schemas/bundle.json", "aria-label": "Address of a bundle or an XSD file", required: true }) as HTMLInputElement;
    const form = h("form", { class: "url-form", onSubmit: (ev: Event) => {
      ev.preventDefault();
      if (urlInput.value.trim()) void this.openUrl(urlInput.value.trim());
    } }, urlInput, h("button", { type: "submit", class: "btn primary" }, "Open"));
    const examples = h("div", { class: "examples" });
    const page = h(
      "div",
      { class: "open-page" },
      this.model ? h("p", null, button("Back", () => this.render(), { icon: "back", cls: "small ghost" })) : null,
      h("header", { class: "open-hero" }, h("h1", null, this.model ? "Open other schemas" : "Explore an XML Schema"), h("p", { class: "lead" }, "Types, elements and groups as UML-like diagrams, content-model trees and readable pages. The files are indexed in your browser; nothing is uploaded.")),
      h(
        "div",
        { class: "open-grid" },
        h("section", { class: "card open-card" }, h("h2", null, "From your computer"), drop),
        h("section", { class: "card open-card" }, h("h2", null, "From the web"), h("p", { class: "muted" }, "The address of a bundle made with ", h("code", null, "schema-explorer index"), ", or of a single .xsd file."), form, h("p", { class: "muted small" }, "Add ", h("code", null, "?bundle="), " and the address to this page's link to open it straight away. The site must allow cross-origin requests."))
      ),
      examples
    );
    this.setMain(page, this.footer());
    void this.loadExamples(examples);
  }

  private async loadExamples(host: HTMLElement): Promise<void> {
    const url = this.opts.examplesUrl ?? (this.opts.routing ? new URL("examples/examples.json", document.baseURI).href : null);
    if (!url) return;
    try {
      const r = await fetch(url, { cache: "no-cache" });
      if (!r.ok || !(r.headers.get("content-type") ?? "").includes("json")) return;
      const list = (await r.json()) as Example[];
      if (!Array.isArray(list) || list.length === 0) return;
      const base = new URL(url, document.baseURI);
      host.append(
        h("h2", null, "Examples"),
        h(
          "div",
          { class: "example-grid" },
          list.map((ex) =>
            h(
              "button",
              { type: "button", class: "example", onClick: () => {
                // Links stay short and portable when the examples sit next to the app.
                const here = new URL(".", document.baseURI).href;
                const rel = (u: string) => (u.startsWith(here) ? u.slice(here.length) : u);
                const src = rel(new URL(ex.src, base).href);
                const sources = ex.sources ? rel(new URL(ex.sources, base).href) : undefined;
                void this.openUrl(src, ex.focus, sources);
              } },
              h("strong", null, ex.title),
              ex.description ? h("span", { class: "muted" }, ex.description) : null,
              ex.publisher ? h("span", { class: "faint small" }, ex.publisher, ex.licence ? ` · ${ex.licence}` : "") : null
            )
          )
        )
      );
    } catch {
      /* no examples */
    }
  }

  showProgress(p: LoadProgress): void {
    const label = p.stage === "download" ? "Downloading" : p.stage === "read" ? "Reading" : "Indexing";
    const det = p.loaded !== undefined ? `${(p.loaded / 1024 / 1024).toFixed(1)} MB${p.total ? ` of ${(p.total / 1024 / 1024).toFixed(1)} MB` : ""}` : p.detail ?? "";
    const pct = p.loaded !== undefined && p.total ? Math.min(100, (100 * p.loaded) / p.total) : undefined;
    const bar = h("i", { class: pct !== undefined ? "det" : "", style: pct !== undefined ? { width: pct + "%" } : {} });
    this.setMain(h("div", { class: "progress" }, h("div", null, h("strong", null, label), " ", h("span", { class: "muted" }, det)), h("div", { class: "bar" }, bar)));
  }

  showError(e: Error, back?: () => void): void {
    this.setMain(h("div", null, h("div", { class: "error" }, String(e.message || e)), back ? button("Try something else", back) : null));
  }

  private wireDrop(): void {
    const root = this.root;
    let over: HTMLElement | null = null;
    root.addEventListener("dragover", (ev) => {
      if (!ev.dataTransfer?.types.includes("Files")) return;
      ev.preventDefault();
      over = root.querySelector(".dropzone");
      over?.classList.add("over");
    });
    root.addEventListener("dragleave", () => over?.classList.remove("over"));
    root.addEventListener("drop", (ev) => {
      if (!ev.dataTransfer?.files.length) return;
      ev.preventDefault();
      over?.classList.remove("over");
      const dt = ev.dataTransfer;
      this.showProgress({ stage: "read", detail: "the dropped files" });
      void readDataTransfer(dt).then((files) => this.openFiles(files.length ? files : []), (e) => this.showError(e as Error, () => this.showOpen()));
    });
  }
}

const PREFS_KEY = "schema-explorer.prefs";
function loadPrefs(): Partial<Prefs> {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}");
  } catch {
    return {};
  }
}
function savePrefs(p: Prefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* private mode */
  }
}
