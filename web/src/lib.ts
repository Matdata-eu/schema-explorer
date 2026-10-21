// The <schema-explorer> web component. Early development: a placeholder that
// loads the WebAssembly core and shows its version.
import init, { version } from "./wasm/schema_explorer_wasm.js";

export class SchemaExplorer extends HTMLElement {
  async connectedCallback(): Promise<void> {
    const root = this.shadowRoot ?? this.attachShadow({ mode: "open" });
    root.innerHTML = `<style>
        :host { font-family: system-ui, sans-serif; }
        main { max-width: 40rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.5; }
      </style>
      <main>
        <h1>schema-explorer</h1>
        <p>A visual explorer for XML Schema (XSD), and later JSON Schema. Early development: the viewer is not ready yet.</p>
        <p><small>Viewer ${__APP_VERSION__} · core <span id="core">…</span> ·
        <a href="https://github.com/Matdata-eu/schema-explorer">source</a></small></p>
      </main>`;
    try {
      await init();
      root.getElementById("core")!.textContent = version();
    } catch (e) {
      root.getElementById("core")!.textContent = "unavailable";
      console.error(e);
    }
  }
}

if (!customElements.get("schema-explorer")) {
  customElements.define("schema-explorer", SchemaExplorer);
}
