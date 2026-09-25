import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

await mkdir(new URL("./bundle/", import.meta.url), { recursive: true });
await build({
  entryPoints: [fileURLToPath(new URL("./server.mjs", import.meta.url))],
  outfile: fileURLToPath(new URL("./bundle/server.mjs", import.meta.url)),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  external: ["@electric-sql/pglite", "pg", "ajv", "liquidjs"],
});
await copyFile(new URL("./schema.sql", import.meta.url), new URL("./bundle/schema.sql", import.meta.url));
