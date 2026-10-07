import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let version: string | undefined;

/**
 * Version of the package that contains this module: the runtime package in the repository, the distribution
 * package when the runtime is bundled into it. Read from the nearest `package.json` above the module.
 */
export function trustRuntimeVersion(): string {
  if (version !== undefined) return version;
  let directory = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const manifest = path.join(directory, "package.json");
    if (existsSync(manifest)) {
      const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { readonly version?: unknown };
      if (typeof parsed.version === "string") {
        version = parsed.version;
        return version;
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error("TRUST runtime package manifest not found");
    directory = parent;
  }
}
