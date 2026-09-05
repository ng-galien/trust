import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { federation } from "@module-federation/vite";

export default defineConfig({
  base: "./",
  plugins: [react(), federation({
    name: "trust_coordination",
    filename: "remoteEntry.js",
    exposes: { "./Page": "./ui/page.tsx" },
    shared: { react: { singleton: true }, "react-dom": { singleton: true } },
  })],
  build: { target: "esnext", rolldownOptions: { input: "./ui/page.tsx" } },
});
