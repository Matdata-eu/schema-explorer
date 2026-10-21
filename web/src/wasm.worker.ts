// Indexes XSD files with the Rust core compiled to WebAssembly, off the main thread.
import init, { expand, index } from "./wasm/schema_explorer_wasm.js";
import wasmUrl from "./wasm/schema_explorer_wasm_bg.wasm?url";

type Req = { id: number; op: "index"; names: string[]; contents: Uint8Array[] } | { id: number; op: "expand"; json: string };

let ready: Promise<unknown> | null = null;

self.onmessage = async (ev: MessageEvent<Req>) => {
  const req = ev.data;
  try {
    if (!ready) ready = init({ module_or_path: wasmUrl });
    await ready;
    const started = performance.now();
    const json = req.op === "index" ? index(req.names, req.contents, false) : expand(req.json);
    (self as unknown as Worker).postMessage({ id: req.id, json, ms: performance.now() - started });
  } catch (e) {
    (self as unknown as Worker).postMessage({ id: req.id, error: String(e) });
  }
};
