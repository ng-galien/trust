import { federation } from "@module-federation/vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type ProxyOptions } from "vite";

import { trustDocsMdx } from "./mdx.mjs";

const runtime = process.env.TRUST_RUNTIME_URL ?? "http://127.0.0.1:4318";
const port = Number(process.env.TRUST_WEB_PORT ?? "4173");
const allowedPreviewHosts = (process.env.TRUST_WEB_ALLOWED_HOSTS ?? "")
  .split(",")
  .map((host) => host.trim())
  .filter(Boolean);
if (allowedPreviewHosts.some((host) => !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host)))
  throw new Error("TRUST_WEB_ALLOWED_HOSTS must contain exact hostnames separated by commas");
const mobileUpstreams = (() => {
  const raw = process.env.TRUST_MOBILE_UPSTREAMS;
  if (!raw) return {} as Record<string, ProxyOptions>;
  const entries: unknown = JSON.parse(raw);
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) throw new Error("Invalid mobile upstream map");
  const proxies: Record<string, ProxyOptions> = {};
  for (const [id, value] of Object.entries(entries)) {
    if (!/^[a-z][a-z0-9-]*$/.test(id) || !value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid mobile upstream entry");
    const entry = value as Record<string, unknown>;
    if (
      Object.keys(entry).some((key) => !["url", "pathMode"].includes(key)) ||
      typeof entry.url !== "string" ||
      (entry.pathMode !== undefined && entry.pathMode !== "strip" && entry.pathMode !== "preserve")
    )
      throw new Error("Invalid mobile upstream entry");
    const target = new URL(entry.url);
    if (
      target.protocol !== "http:" ||
      target.hostname !== "127.0.0.1" ||
      !target.port ||
      target.pathname !== "/" ||
      target.search ||
      target.hash ||
      target.username ||
      target.password
    )
      throw new Error("Mobile upstreams must be exact loopback HTTP origins");
    proxies[`^/mobile/apps/${id}(?:/|$)`] = {
      target: target.origin,
      ws: true,
      changeOrigin: true,
      configure: (proxy) => {
        proxy.on("proxyReq", (upstream, request) => {
          if (request.headers.origin) upstream.setHeader("Origin", target.origin);
          if (request.headers.referer) upstream.setHeader("Referer", `${target.origin}/`);
        });
        proxy.on("proxyReqWs", (upstream, request) => {
          if (request.headers.origin) upstream.setHeader("Origin", target.origin);
          if (request.headers.referer) upstream.setHeader("Referer", `${target.origin}/`);
        });
      },
      ...(entry.pathMode === "preserve"
        ? {}
        : { rewrite: (path) => path.replace(new RegExp(`^/mobile/apps/${id}`), "") || "/" }),
    };
  }
  return proxies;
})();

// An aborted upstream stream does not emit `end`; close the browser response so EventSource reconnects.
const streamingProxy: ProxyOptions["configure"] = (proxy) => {
  proxy.on("proxyRes", (upstream, _request, response) => {
    if (!upstream.headers["content-type"]?.startsWith("text/event-stream")) return;
    upstream.once("close", () => {
      if (!upstream.complete) response.destroy();
    });
  });
};

const developmentAuthenticationProxy: ProxyOptions = {
  target: runtime,
  changeOrigin: false,
  configure: (proxy) => {
    proxy.on("proxyReq", (upstream, request) => {
      if (request.headers.host) upstream.setHeader("Host", request.headers.host);
    });
  },
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
      ...mobileUpstreams,
      "/health": runtime,
      "/auth/config": runtime,
      "/auth/dev": developmentAuthenticationProxy,
      "/.well-known/oauth-protected-resource": runtime,
      "/v1/traces": runtime,
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
    allowedHosts: allowedPreviewHosts,
    proxy: {
      ...mobileUpstreams,
      "/health": runtime,
      "/auth/config": runtime,
      "/auth/dev": developmentAuthenticationProxy,
      "/.well-known/oauth-protected-resource": runtime,
      "/v1/traces": runtime,
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
