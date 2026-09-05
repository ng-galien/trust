import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { federation } from "@module-federation/vite";

import { trustDocsMdx } from "./mdx.mjs";

const runtime = process.env.TRUST_RUNTIME_URL ?? "http://127.0.0.1:4318";
const port = Number(process.env.TRUST_WEB_PORT ?? "4173");

export default defineConfig({
  plugins: [trustDocsMdx(), react(), tailwindcss(), federation({
    name: "trust_host",
    remotes: {},
    shared: { react: { singleton: true }, "react-dom": { singleton: true } },
  })],
  server: {
    port,
    strictPort: true,
    // The UI package is a symlinked workspace outside this root; native events proved unreliable for it.
    watch: {
      usePolling: true, interval: 300,
      // Federation regenerates these files after loading a remote. Watching them
      // reloads the page, which loads the remote again and regenerates them again.
      ignored: ["**/@mf-types/**", "**/.mf/**"],
    },
    proxy: {
      "/health": runtime,
      "/extensions": { target: runtime, bypass: (request) => request.headers.accept?.includes("text/html") ? "/index.html" : undefined },
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
      "/extensions": { target: runtime, bypass: (request) => request.headers.accept?.includes("text/html") ? "/index.html" : undefined },
      "/rpc": runtime,
      "/otlp": runtime,
      "/events": runtime,
      "/lsp": { target: runtime, ws: true },
    },
  },
});
