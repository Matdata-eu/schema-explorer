import { defineConfig } from "vite";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

// The app build: everything the static site and the embedded `serve` viewer need.
// ELK and the WASM parser live in their own workers, so the main bundle stays small.
export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
  },
  worker: { format: "es" },
  server: { port: 5173 },
});
