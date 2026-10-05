import { defineConfig } from "vite";

/**
 * Extension build: the panel (the same app, in embed mode) and the options
 * page. Relative paths so the pages work from a chrome-extension:// origin.
 * The background worker and content script are bundled separately by esbuild —
 * a content script cannot be an ES module, and the worker must stay one file.
 */
export default defineConfig({
  base: "./",
  build: {
    outDir: "dist-ext",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: true,
    rollupOptions: { input: { panel: "panel.html", options: "options.html" } },
  },
});
