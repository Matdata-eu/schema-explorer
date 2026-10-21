// <schema-explorer>: the viewer as a web component.
import { App } from "./app";
import type { Bundle } from "./model";
import css from "./styles.css?inline";
import { addFonts } from "./fonts";

let sheet: CSSStyleSheet | null = null;
function styles(): CSSStyleSheet {
  if (!sheet) {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
  }
  return sheet;
}

/**
 * Attributes:
 *  - `src`      URL of a bundle.json (or of a single .xsd file)
 *  - `sources`  base URL of the .xsd files, for the source view (default: next to the bundle)
 *  - `focus`    component to open first: `prefix:Name` or `ct/prefix:Name`
 *  - `theme`    light | dark | auto
 *  - `routing`  present: use location.hash for navigation (the standalone app)
 *  - `minimal`  present: no sidebar or top bar, only the page
 *  - `examples` URL of an examples.json list for the open screen
 * Events: `se-navigate` {name, route}, `se-loaded` {bundle}, `se-error` {error}
 */
export class SchemaExplorerElement extends HTMLElement {
  static observedAttributes = ["src", "focus", "theme"];
  private app: App | null = null;
  private started = false;

  connectedCallback(): void {
    if (this.app) return;
    addFonts();
    const shadow = this.shadowRoot ?? this.attachShadow({ mode: "open" });
    shadow.adoptedStyleSheets = [styles()];
    const root = document.createElement("div");
    root.style.height = "100%";
    shadow.appendChild(root);
    if (!this.style.height && !this.hasAttribute("routing")) this.style.minHeight = "480px";
    const routing = this.hasAttribute("routing");
    this.app = new App(root, {
      routing,
      embed: !routing,
      minimal: this.hasAttribute("minimal"),
      theme: (this.getAttribute("theme") as "light" | "dark" | "auto" | null) ?? undefined,
      examplesUrl: this.getAttribute("examples") ?? undefined,
      onNavigate: (name, route) => this.dispatchEvent(new CustomEvent("se-navigate", { detail: { name, route }, bubbles: true, composed: true })),
      onLoaded: (bundle) => this.dispatchEvent(new CustomEvent("se-loaded", { detail: { bundle }, bubbles: true, composed: true })),
      onError: (error) => this.dispatchEvent(new CustomEvent("se-error", { detail: { error }, bubbles: true, composed: true })),
    });
    this.started = true;
    const q = routing ? new URLSearchParams(location.search) : null;
    const src = this.getAttribute("src") ?? q?.get("bundle") ?? q?.get("src") ?? null;
    const focus = this.getAttribute("focus") ?? q?.get("focus") ?? null;
    const sources = this.getAttribute("sources") ?? q?.get("sources") ?? null;
    const compare = this.getAttribute("compare") ?? q?.get("compare") ?? null;
    const compareSources = this.getAttribute("compare-sources") ?? q?.get("compareSources") ?? null;
    void this.app.start(src, focus, sources, compare, compareSources);
  }

  disconnectedCallback(): void {
    this.app?.destroy();
  }

  attributeChangedCallback(name: string, old: string | null, value: string | null): void {
    if (!this.started || !this.app || old === value) return;
    if (name === "src" && value) void this.app.openUrl(value, this.getAttribute("focus") ?? undefined, this.getAttribute("sources") ?? undefined);
    else if (name === "focus" && value) this.app.goTo(value);
    else if (name === "theme" && value) this.app.setPrefs({ theme: value as "light" | "dark" | "auto" });
  }

  /** Load a bundle object, a URL, or .xsd files. */
  async load(input: string | Bundle | FileList | File[]): Promise<void> {
    if (!this.app) throw new Error("element not connected");
    if (typeof input === "string") await this.app.openUrl(input);
    else if (input instanceof FileList || Array.isArray(input)) await this.app.openFiles(input);
    else this.app.setBundle(input);
  }

  /** Open a global component by `prefix:Name` (or `ct/prefix:Name`); false when it is not there. */
  goTo(name: string, tab?: "diagram" | "tree"): boolean {
    return this.app?.goTo(name, tab) ?? false;
  }

  get bundle(): Bundle | null {
    return this.app?.bundle ?? null;
  }
}

export function define(tag = "schema-explorer"): void {
  if (!customElements.get(tag)) customElements.define(tag, SchemaExplorerElement);
}
