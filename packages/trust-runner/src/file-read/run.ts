import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import type { FileJsonResult, FileRead, FileTextResult, JsonValue } from "@trust/operation";

import type { JsonObject } from "../lib/json.js";

export type FileReadResult = FileTextResult | FileJsonResult;

const MAX_FILE_BYTES = 10 * 1024 * 1024;

export async function runFileRead(file: FileRead, environment: JsonObject): Promise<FileReadResult> {
  const rootValue = environment[file.root.environment];
  if (typeof rootValue !== "string" || !isAbsolute(rootValue)) {
    throw new Error(`Environment "${file.root.environment}" must be an absolute directory.`);
  }
  const root = await realpath(rootValue);
  const target = await realpath(resolve(root, file.relativePath));
  const pathFromRoot = relative(root, target);
  if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(pathFromRoot)) {
    throw new Error(`File "${file.relativePath}" resolves outside Environment "${file.root.environment}".`);
  }

  const bytes = await readFile(target);
  if (bytes.byteLength > MAX_FILE_BYTES) {
    throw new Error(`File "${file.relativePath}" exceeds ${MAX_FILE_BYTES} bytes.`);
  }
  const text = bytes.toString("utf8");
  if (file.format === "text") {
    return { relativePath: file.relativePath, content: text };
  }
  try {
    return { relativePath: file.relativePath, content: JSON.parse(text) as JsonValue };
  } catch (error) {
    throw new Error(`File "${file.relativePath}" is not valid JSON.`, { cause: error });
  }
}
