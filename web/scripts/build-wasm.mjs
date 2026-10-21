// Build the Rust core for the browser and place the wasm-bindgen output in
// src/wasm/. Needs the wasm32-unknown-unknown target and wasm-bindgen-cli
// (same version as the wasm-bindgen crate in Cargo.lock).
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const out = resolve(here, "../src/wasm");
const profile = process.env.WASM_PROFILE || "release";

function run(cmd) {
  console.log("$ " + cmd);
  execSync(cmd, { stdio: "inherit", cwd: root });
}

if (process.env.SKIP_WASM === "1") {
  console.log("SKIP_WASM=1: keeping the existing src/wasm/");
  process.exit(0);
}

const lock = readFileSync(resolve(root, "Cargo.lock"), "utf8");
const m = lock.match(/name = "wasm-bindgen"\nversion = "([^"]+)"/);
const wanted = m ? m[1] : "unknown";
let have = "";
try {
  have = execSync("wasm-bindgen --version", { encoding: "utf8" }).trim().split(" ").pop();
} catch {
  console.error(`wasm-bindgen-cli is not installed. Run: cargo install wasm-bindgen-cli --version ${wanted}`);
  process.exit(1);
}
if (have !== wanted) {
  console.warn(`warning: wasm-bindgen-cli ${have} differs from the wasm-bindgen crate ${wanted}; run: cargo install wasm-bindgen-cli --version ${wanted} --force`);
}

run(`cargo build -p schema-explorer-wasm --target wasm32-unknown-unknown ${profile === "release" ? "--release" : ""}`);
mkdirSync(out, { recursive: true });
const wasm = resolve(root, `target/wasm32-unknown-unknown/${profile}/schema_explorer_wasm.wasm`);
run(`wasm-bindgen "${wasm}" --out-dir "${out}" --target web --no-typescript`);
if (!existsSync(resolve(out, "schema_explorer_wasm.js"))) {
  console.error("wasm-bindgen produced no output");
  process.exit(1);
}
// A .d.ts for the generated module so tsc is happy.
writeFileSync(
  resolve(out, "schema_explorer_wasm.d.ts"),
  `export default function init(input?: { module_or_path?: string | URL | Request | BufferSource | WebAssembly.Module } | string | URL): Promise<unknown>;
export function version(): string;
`
);
console.log("wasm ready in web/src/wasm/");
