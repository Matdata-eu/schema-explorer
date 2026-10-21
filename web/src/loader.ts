// Getting a bundle from somewhere: a bundle URL, dropped schema files and
// folders (indexed in a WebAssembly worker), or the local `serve` server.
import type { SchemaDiff } from "./diff";
import type { Bundle } from "./model";

export interface LoadProgress {
  stage: "download" | "read" | "index";
  detail?: string;
  loaded?: number;
  total?: number;
}

export interface ServerStatus {
  server: boolean;
  version?: string;
  loaded?: boolean;
  title?: string;
}

export interface NamedBytes {
  name: string;
  bytes: Uint8Array;
}

/** Where the viewer is served from; API calls are relative to it. */
export function baseUrl(): string {
  return new URL(".", document.baseURI).href;
}

export async function serverStatus(): Promise<ServerStatus | null> {
  try {
    const r = await fetch(new URL("api/status", baseUrl()), { cache: "no-store" });
    if (!r.ok || !(r.headers.get("content-type") ?? "").includes("json")) return null;
    const j = (await r.json()) as ServerStatus;
    return j.server ? j : null;
  } catch {
    return null;
  }
}

export async function fetchBundleFromServer(progress?: (p: LoadProgress) => void): Promise<Bundle> {
  const r = await fetch(new URL("api/bundle", baseUrl()), { cache: "no-store" });
  if (!r.ok) throw new Error(`the server has no schemas loaded (${r.status})`);
  return checkBundle(JSON.parse(new TextDecoder().decode(await readWithProgress(r, progress))), progress);
}

/** Load a URL: a bundle (JSON) or a single schema file (.xsd, JSON Schema, OpenAPI, AsyncAPI). */
export async function loadUrl(url: string, progress?: (p: LoadProgress) => void): Promise<Bundle> {
  const abs = new URL(url, document.baseURI).href;
  progress?.({ stage: "download", detail: abs });
  let resp: Response;
  try {
    resp = await fetch(abs);
  } catch (e) {
    throw new Error(`cannot fetch ${abs}: ${String((e as Error).message || e)}. The host may not allow cross-origin requests; download the files and drop them here instead.`);
  }
  if (!resp.ok) throw new Error(`cannot fetch ${abs}: HTTP ${resp.status}`);
  const bytes = await readWithProgress(resp, progress);
  const name = new URL(abs).pathname.split("/").pop() || "schema.xsd";
  if (/\.xsd$/i.test(name) || bytes[0] === 0x3c || (bytes[0] === 0xef && bytes[3] === 0x3c)) {
    return indexFiles([{ name, bytes }], progress);
  }
  if (/\.ya?ml$/i.test(name)) return indexFiles([{ name, bytes }], progress);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error(`${abs} is neither a schema-explorer bundle (JSON) nor a schema file`);
  }
  if (!isBundle(parsed)) return indexFiles([{ name: /\.json$/i.test(name) ? name : "schema.json", bytes }], progress);
  return checkBundle(parsed, progress);
}

async function readWithProgress(resp: Response, progress?: (p: LoadProgress) => void): Promise<Uint8Array> {
  const total = Number(resp.headers.get("content-length") ?? 0) || undefined;
  if (!resp.body || !progress) return new Uint8Array(await resp.arrayBuffer());
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    progress({ stage: "download", loaded, total });
  }
  const out = new Uint8Array(loaded);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

let wasmWorker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (json: string) => void; reject: (e: Error) => void }>();

function worker(): Worker {
  if (!wasmWorker) {
    wasmWorker = new Worker(new URL("./wasm.worker.ts", import.meta.url), { type: "module" });
    wasmWorker.onmessage = (ev: MessageEvent<{ id: number; json?: string; error?: string }>) => {
      const p = pending.get(ev.data.id);
      if (!p) return;
      pending.delete(ev.data.id);
      if (ev.data.error) p.reject(new Error(ev.data.error));
      else p.resolve(ev.data.json as string);
    };
    wasmWorker.onerror = (e) => {
      for (const p of pending.values()) p.reject(new Error(e.message || "the indexer could not start"));
      pending.clear();
      wasmWorker = null;
    };
  }
  return wasmWorker;
}

function call(msg: Record<string, unknown>, transfer: Transferable[] = []): Promise<string> {
  const id = ++seq;
  return new Promise<string>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker().postMessage({ id, ...msg }, transfer);
  });
}

/** Index schema files in the browser (WebAssembly, in a worker). */
export async function indexFiles(files: NamedBytes[], progress?: (p: LoadProgress) => void): Promise<Bundle> {
  progress?.({ stage: "index", detail: files.length === 1 ? files[0].name : `${files.length} files` });
  // Copies go to the worker; the originals stay here for the source view.
  const contents = files.map((f) => f.bytes.slice());
  const json = await call({ op: "index", names: files.map((f) => f.name), contents }, contents.map((c) => c.buffer as ArrayBuffer));
  return checkBundle(JSON.parse(json));
}

/** Compare two bundles (WebAssembly, in a worker); `old` is the earlier version. */
export async function diffBundles(old: Bundle, cur: Bundle, options: Record<string, boolean> = {}): Promise<SchemaDiff> {
  const strip = (b: Bundle) => JSON.stringify({ ...b, search: {} });
  return JSON.parse(await call({ op: "diff", old: strip(old), new: strip(cur), options: JSON.stringify(options) })) as SchemaDiff;
}

/** A Markdown or HTML report of a diff. */
export function diffReport(d: SchemaDiff, format: "md" | "html"): Promise<string> {
  return call({ op: "report", json: JSON.stringify(d), format });
}

/** Schema file names: XSD, and JSON or YAML (JSON Schema, OpenAPI, AsyncAPI, or a bundle). */
export const SCHEMA_FILE = /\.(xsd|json|ya?ml)$/i;

/** A bundle made by `schema-explorer index`, as opposed to a JSON Schema. */
export function isBundle(x: unknown): x is Bundle {
  return !!x && typeof x === "object" && typeof (x as Bundle).format === "number" && Array.isArray((x as Bundle).components);
}

/** The single dropped file when it is a bundle. */
export function bundleFile(named: NamedBytes[]): Bundle | null {
  if (named.length !== 1 || !/\.json$/i.test(named[0].name)) return null;
  try {
    const x: unknown = JSON.parse(new TextDecoder().decode(named[0].bytes));
    return isBundle(x) ? x : null;
  } catch {
    return null;
  }
}

/** The files to index: the .xsd files, or else the JSON and YAML files. */
export function schemaFiles(named: NamedBytes[]): NamedBytes[] {
  const xsd = named.filter((f) => /\.xsd$/i.test(f.name));
  return xsd.length ? xsd : named.filter((f) => /\.(json|ya?ml)$/i.test(f.name));
}

/** The schema at a JSON pointer of a JSON or YAML file, as indented JSON. */
export function jsonSource(name: string, text: string, pointer: string): Promise<string> {
  return call({ op: "source", name, text, pointer });
}

/** Read dropped or picked files; directories are walked for schema files. */
export async function readDataTransfer(dt: DataTransfer): Promise<NamedBytes[]> {
  const entries = Array.from(dt.items)
    .map((i) => (i.kind === "file" ? i.webkitGetAsEntry?.() : null))
    .filter((e): e is FileSystemEntry => !!e);
  if (entries.length === 0) return readFiles(dt.files);
  const out: NamedBytes[] = [];
  const walk = async (e: FileSystemEntry, path: string): Promise<void> => {
    if (e.isFile) {
      if (!SCHEMA_FILE.test(e.name)) return;
      const file = await new Promise<File>((res, rej) => (e as FileSystemFileEntry).file(res, rej));
      out.push({ name: path + e.name, bytes: new Uint8Array(await file.arrayBuffer()) });
    } else if (e.isDirectory) {
      const reader = (e as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        if (batch.length === 0) break;
        for (const c of batch) await walk(c, path + e.name + "/");
      }
    }
  };
  for (const e of entries) await walk(e, "");
  return out;
}

export async function readFiles(list: FileList | File[]): Promise<NamedBytes[]> {
  const out: NamedBytes[] = [];
  for (const f of Array.from(list)) {
    if (!SCHEMA_FILE.test(f.name)) continue;
    out.push({ name: f.webkitRelativePath || f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
  }
  return out;
}

async function checkBundle(b: unknown, progress?: (p: LoadProgress) => void): Promise<Bundle> {
  const x = b as Bundle;
  if (!x || typeof x !== "object" || !Array.isArray(x.components)) throw new Error("this is not a schema-explorer bundle");
  if (x.format !== 1) throw new Error(`bundle format ${x.format} is not supported by this viewer (expected 1)`);
  if (x.compact) {
    progress?.({ stage: "index", detail: "content models and search index" });
    return JSON.parse(await call({ op: "expand", json: JSON.stringify(x) })) as Bundle;
  }
  return x;
}

/** The text of the files of a bundle, from wherever it came from. */
export type SourceProvider = (file: number, name: string) => Promise<string | null>;

export function memorySources(files: NamedBytes[]): SourceProvider {
  const dec = new TextDecoder();
  return async (_file, name) => {
    const hit = files.find((f) => f.name === name || f.name.endsWith("/" + name));
    return hit ? dec.decode(hit.bytes) : null;
  };
}

export function urlSources(base: string): SourceProvider {
  return async (_file, name) => {
    try {
      const r = await fetch(new URL(name.split("/").map(encodeURIComponent).join("/"), base));
      if (!r.ok) return null;
      const text = await r.text();
      // A web server answering with its HTML page is not the file.
      const html = /^<(!doctype html|html)/i.test(text.trimStart());
      return text.trimStart().startsWith("<") || /\.(json|ya?ml)$/i.test(name) ? (html ? null : text) : null;
    } catch {
      return null;
    }
  };
}

export function serverSources(): SourceProvider {
  return async (file) => {
    try {
      const r = await fetch(new URL(`api/source/${file}`, baseUrl()));
      return r.ok ? await r.text() : null;
    } catch {
      return null;
    }
  };
}
