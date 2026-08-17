import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const runtime = process.env.TRUST_RUNTIME_URL ?? "http://127.0.0.1:4318";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 4173,
    // The UI package is a symlinked workspace outside this root; native events proved unreliable for it.
    watch: { usePolling: true, interval: 300 },
    proxy: {
      "/health": runtime,
      "/rpc": runtime,
      "/otlp": runtime,
      "/events": runtime,
    },
  },
  preview: {
    port: 4173,
    proxy: {
      "/health": runtime,
      "/rpc": runtime,
      "/otlp": runtime,
      "/events": runtime,
    },
  },
});
