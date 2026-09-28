import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const [configurationFile, clientId] = process.argv.slice(2);
if (!configurationFile || !clientId) {
  process.stderr.write(
    "Usage: node scripts/create-development-service-secret.mjs <trust-configuration.json> <client-id>\n",
  );
  process.exit(2);
}
const configuration = JSON.parse(await readFile(configurationFile, "utf8"));
const service = configuration?.authentication?.development?.services?.find((item) => item.clientId === clientId);
if (configuration?.authentication?.profile !== "development" || !service?.secretFile)
  throw new Error("The service is not configured for embedded development authentication.");
const destination = service.secretFile;
const directory = path.dirname(destination);
await mkdir(directory, { recursive: true, mode: 0o700 });
await chmod(directory, 0o700);
const temporary = `${destination}.${process.pid}.new`;
await writeFile(temporary, randomBytes(32).toString("base64url") + "\n", { mode: 0o600 });
await chmod(temporary, 0o600);
await rename(temporary, destination);
process.stdout.write(`Development service credential written to ${destination}.\n`);
