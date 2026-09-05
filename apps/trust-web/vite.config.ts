import { federation } from "@module-federation/vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type ProxyOptions } from "vite";

import { trustDocsMdx } from "./mdx.mjs";

const runtime = process.env.TRUST_RUNTIME_URL ?? "http://127.0.0.1:4318";
const port = Number(process.env.TRUST_WEB_PORT ?? "4173");

// An aborted upstream stream does not emit `end`; close the browser response so EventSource reconnects.
const streamingProxy: ProxyOptions["configure"] = (proxy) => {
  proxy.on("proxyRes", (upstream, _request, response) => {
    if (!upstream.headers["content-type"]?.startsWith("text/event-stream")) return;
    upstream.once("close", () => {
      if (!upstream.complete) response.destroy();
    });
  });
};

export default defineConfig({
  // Acceptance servers and the user's live preview run concurrently. They must
  // not replace each other's optimized dependency chunks (notably Monaco).
  cacheDir: `node_modules/.vite/trust-${port}-${new URL(runtime).port || "default"}`,
  plugins: [
    trustDocsMdx(),
    react(),
    tailwindcss(),
    federation({
      name: "trust_host",
      remotes: {},
      shared: { react: { singleton: true }, "react-dom": { singleton: true } },
    }),
  ],
  server: {
    port,
    strictPort: true,
    // The UI package is a symlinked workspace outside this root; native events proved unreliable for it.
    watch: {
      usePolling: true,
      interval: 300,
      // Federation regenerates these files after loading a remote. Watching them
      // reloads the page, which loads the remote again and regenerates them again.
      ignored: ["**/@mf-types/**", "**/.mf/**"],
    },
    proxy: {
      "/health": runtime,
      "/extensions": {
        target: runtime,
        configure: streamingProxy,
        bypass: (request) => (request.headers.accept?.includes("text/html") ? "/index.html" : undefined),
      },
      "/rpc": runtime,
      "/otlp": runtime,
      "/events": { target: runtime, configure: streamingProxy },
      "/lsp": { target: runtime, ws: true },
    },
  },
  preview: {
    port,
    strictPort: true,
    proxy: {
      "/health": runtime,
      "/extensions": {
        target: runtime,
        configure: streamingProxy,
        bypass: (request) => (request.headers.accept?.includes("text/html") ? "/index.html" : undefined),
      },
      "/rpc": runtime,
      "/otlp": runtime,
      "/events": { target: runtime, configure: streamingProxy },
      "/lsp": { target: runtime, ws: true },
    },
  },
});
