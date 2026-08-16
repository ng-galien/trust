import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { EnvironmentPath } from "@trust/operation";

import type { JsonObject } from "./json.js";

/* Directory resolution shared by Shell and File steps: the Environment names the place where all
   projects live; an optional Input names the project. The result must be one real directory
   inside the root — no path segments, no traversal, no symbolic link out of the root. */

const PROJECT_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class DirectoryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DirectoryError";
  }
}

export async function resolveEnvironmentDirectory(
  path: EnvironmentPath,
  input: JsonObject,
  environment: JsonObject,
  label: string,
): Promise<{ root: string; directory: string }> {
  const rootValue = environment[path.environment];
  if (typeof rootValue !== "string" || !isAbsolute(rootValue)) {
    throw new DirectoryError(`${label}: Environment "${path.environment}" must be an absolute directory.`);
  }
  const root = await realpath(rootValue);
  if (path.appendInput === undefined) return { root, directory: root };

  const segment = input[path.appendInput];
  if (typeof segment !== "string" || !PROJECT_SEGMENT.test(segment) || segment === "." || segment === "..") {
    throw new DirectoryError(`${label}: Input "${path.appendInput}" must name one directory below Environment "${path.environment}".`);
  }
  const candidate = resolve(root, segment);
  let metadata;
  try {
    metadata = await lstat(candidate);
  } catch (error) {
    throw new DirectoryError(`${label}: "${segment}" does not exist below Environment "${path.environment}".`, { cause: error });
  }
  if (metadata.isSymbolicLink()) throw new DirectoryError(`${label}: "${segment}" must not be a symbolic link.`);
  if (!metadata.isDirectory()) throw new DirectoryError(`${label}: "${segment}" must be a directory.`);
  const directory = await realpath(candidate);
  const fromRoot = relative(root, directory);
  if (fromRoot === "" || fromRoot.startsWith(`..${sep}`) || fromRoot === ".." || isAbsolute(fromRoot)) {
    throw new DirectoryError(`${label}: "${segment}" resolves outside Environment "${path.environment}".`);
  }
  return { root, directory };
}
