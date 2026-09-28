import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const configurationFile = process.argv[2];
if (!configurationFile) {
  process.stderr.write("Usage: node scripts/create-development-code.mjs <trust-configuration.json>\n");
  process.exit(2);
}
const configuration = JSON.parse(await readFile(configurationFile, "utf8"));
const development = configuration?.authentication?.development;
if (configuration?.authentication?.profile !== "development" || !development?.local?.codeFile) {
  throw new Error("The configuration does not enable embedded development authentication.");
}
const destination = development.local.codeFile;
const directory = path.dirname(destination);
await mkdir(directory, { recursive: true, mode: 0o700 });
await chmod(directory, 0o700);
const code = randomBytes(18).toString("base64url");
const temporary = `${destination}.${process.pid}.new`;
await writeFile(
  temporary,
  JSON.stringify({
    codeHash: createHash("sha256").update(code).digest("hex"),
    expiresAt: Date.now() + 120_000,
  }) + "\n",
  { mode: 0o600 },
);
await chmod(temporary, 0o600);
await rename(temporary, destination);
process.stdout.write(`One-time TRUST development code (expires in 2 minutes): ${code}\n`);
