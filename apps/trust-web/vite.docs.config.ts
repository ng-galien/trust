import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

import { trustDocsMdx } from "./mdx.mjs";

/* The documentation as one self-contained HTML file (`npm run build:docs` → dist-docs/index.html):
   scripts, styles, fonts, screenshots and diagrams inlined, hash routing — it opens from a file:// URL
   and can be sent as a zip. */
export default defineConfig({
  plugins: [trustDocsMdx(), react(), tailwindcss(), viteSingleFile({ removeViteModuleLoader: true })],
  define: { "import.meta.env.VITE_TRUST_DOCS_STANDALONE": JSON.stringify("1") },
  build: {
    outDir: "dist-docs",
    emptyOutDir: true,
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 100_000,
    rollupOptions: { input: "docs.html" },
  },
});
