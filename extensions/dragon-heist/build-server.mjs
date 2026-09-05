import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";

await mkdir(new URL("./bundle/", import.meta.url), { recursive: true });
await copyFile(new URL("./server.mjs", import.meta.url), new URL("./bundle/server.mjs", import.meta.url));
const root = new URL("../../", import.meta.url);
const procedures = [];
const operations = [];
for (const [kind, directory, output] of [
  ["procedure", new URL("assets/procedures/dragon-heist/", root), procedures],
  ["operation", new URL("assets/operations/", root), operations],
]) {
  for (const name of (await readdir(directory)).sort()) {
    if (!name.endsWith(".feature") || (kind === "operation" && !name.startsWith("dragon-heist."))) continue;
    const source = await readFile(new URL(name, directory), "utf8");
    const id = source.match(new RegExp(`@${kind}:([^\\s]+)`))?.[1];
    const version = source.match(/@version:([^\s]+)/)?.[1];
    if (!id || !version) throw new Error(`Missing ${kind} metadata in ${name}`);
    output.push({ id, [kind]: id, version, source });
  }
}
await writeFile(
  new URL("./bundle/catalog.json", import.meta.url),
  JSON.stringify({ sourceKind: "bundled", procedures, operations }),
);
