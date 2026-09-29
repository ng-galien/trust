import { federation } from "@module-federation/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** The runtime refuses asset names that look like sources (src-, server-, data-…); such chunks get a neutral name. */
const chunkFileNames = (chunk: { name: string }) =>
  /^(?:server|backend|src|source|data|node_modules)$/iu.test(chunk.name)
    ? "assets/chunk-[hash].js"
    : "assets/[name]-[hash].js";

export default defineConfig({
  base: "./",
  plugins: [
    react(),
    federation({
      name: "trust_mobile_companion",
      filename: "remoteEntry.js",
      exposes: { "./Page": "./ui/page.tsx" },
      shared: { react: { singleton: true }, "react-dom": { singleton: true } },
    }),
  ],
  build: { target: "esnext", rolldownOptions: { input: "./ui/page.tsx", output: { chunkFileNames } } },
});
