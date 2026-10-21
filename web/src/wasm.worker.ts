// Indexes schema files with the Rust core compiled to WebAssembly, off the main thread.
import init, { diff, diff_report, expand, index, json_source } from "./wasm/schema_explorer_wasm.js";
import wasmUrl from "./wasm/schema_explorer_wasm_bg.wasm?url";

type Req =
  | { id: number; op: "index"; names: string[]; contents: Uint8Array[] }
  | { id: number; op: "expand"; json: string }
  | { id: number; op: "diff"; old: string; new: string; options: string }
  | { id: number; op: "report"; json: string; format: string }
  | { id: number; op: "source"; name: string; text: string; pointer: string };

let ready: Promise<unknown> | null = null;

self.onmessage = async (ev: MessageEvent<Req>) => {
  const req = ev.data;
  try {
    if (!ready) ready = init({ module_or_path: wasmUrl });
    await ready;
    const started = performance.now();
    const json =
      req.op === "index"
        ? index(req.names, req.contents, false)
        : req.op === "expand"
          ? expand(req.json)
          : req.op === "diff"
            ? diff(req.old, req.new, req.options)
            : req.op === "source"
              ? json_source(req.name, req.text, req.pointer)
              : diff_report(req.json, req.format);
    (self as unknown as Worker).postMessage({ id: req.id, json, ms: performance.now() - started });
  } catch (e) {
    (self as unknown as Worker).postMessage({ id: req.id, error: String(e) });
  }
};
