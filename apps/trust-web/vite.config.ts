import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

import { trustDocsMdx } from "./mdx.mjs";

const runtime = process.env.TRUST_RUNTIME_URL ?? "http://127.0.0.1:4318";
const port = Number(process.env.TRUST_WEB_PORT ?? "4173");

export default defineConfig({
  plugins: [trustDocsMdx(), react(), tailwindcss()],
  server: {
    port,
    strictPort: true,
    // The UI package is a symlinked workspace outside this root; native events proved unreliable for it.
    watch: { usePolling: true, interval: 300 },
    proxy: {
      "/health": runtime,
      "/rpc": runtime,
      "/otlp": runtime,
      "/events": runtime,
      "/lsp": { target: runtime, ws: true },
    },
  },
  preview: {
    port,
    strictPort: true,
    proxy: {
      "/health": runtime,
      "/rpc": runtime,
      "/otlp": runtime,
      "/events": runtime,
      "/lsp": { target: runtime, ws: true },
    },
  },
});
