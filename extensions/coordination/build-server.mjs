import { mkdir, copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = new URL("./", import.meta.url);
await mkdir(new URL("bundle/", root), { recursive: true });
await build({
  entryPoints: [fileURLToPath(new URL("server.mjs", root))],
  outfile: fileURLToPath(new URL("bundle/server.mjs", root)),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  external: ["pg-native"],
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
// The environment retains the single maintained schema source; the artifact carries its exact bytes.
await copyFile(
  new URL("../../environments/trust-test/manifests/postgres/002-missions.sql", root),
  new URL("bundle/schema.sql", root),
);
await copyFile(new URL("classification.sql", root), new URL("bundle/classification.sql", root));
