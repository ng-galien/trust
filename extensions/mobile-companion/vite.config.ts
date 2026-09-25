import { federation } from "@module-federation/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

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
  build: { target: "esnext", rolldownOptions: { input: "./ui/page.tsx" } },
});
