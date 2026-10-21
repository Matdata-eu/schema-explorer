import { defineConfig } from "vite";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

// The library build: the <schema-explorer> web component as one ES module
// (workers and the WASM file are emitted next to it).
export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  build: {
    outDir: "dist-lib",
    emptyOutDir: true,
    target: "es2022",
    lib: {
      entry: "src/lib.ts",
      formats: ["es"],
      fileName: () => "schema-explorer.js",
    },
    rollupOptions: { output: { inlineDynamicImports: false } },
  },
  worker: { format: "es" },
});
