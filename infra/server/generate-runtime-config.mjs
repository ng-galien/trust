#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildServerPrincipalConfiguration } from "./lib/bootstrap-identity.mjs";

export async function generateServerRuntimeConfig(options) {
  const outputDirectory = absolute(options?.outputDirectory, "outputDirectory");
  const authority = await buildServerPrincipalConfiguration(options?.environment ?? process.env);
  await mkdir(outputDirectory, { recursive: true });
  const principalsPath = resolve(outputDirectory, "registry-principals.json");
  await writeFile(principalsPath, `${JSON.stringify(authority.principals, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o644,
  });
  return Object.freeze({
    principalsPath,
    identities: authority.identities,
  });
}

if (
  process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const args = parseArguments(process.argv.slice(2));
  const result = await generateServerRuntimeConfig(args);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function parseArguments(args) {
  if (args.length !== 2 || args[0] !== "--output-directory") {
    throw new TypeError("usage: generate-runtime-config.mjs --output-directory <absolute-path>");
  }
  return { outputDirectory: args[1] };
}

function absolute(value, label) {
  const supplied = required(value, label);
  if (!isAbsolute(supplied)) throw new TypeError(`${label} must be absolute`);
  return resolve(supplied);
}

function required(value, label) {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0")) {
    throw new TypeError(`${label} must be a non-empty string without NUL`);
  }
  return value;
}
