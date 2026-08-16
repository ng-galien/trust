import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";


import type { FileJsonResult, FileRead, FileTextResult, JsonValue } from "@trust/operation";

import { clip, nullReporter, type StepReporter } from "../diagnostics/events.js";
import type { JsonObject } from "../lib/json.js";
import { resolveEnvironmentDirectory } from "../lib/paths.js";

export type FileReadResult = FileTextResult | FileJsonResult;

const MAX_FILE_BYTES = 10 * 1024 * 1024;

export async function runFileRead(file: FileRead, input: JsonObject, environment: JsonObject, reporter: StepReporter = nullReporter): Promise<FileReadResult> {
  const { directory: root } = await resolveEnvironmentDirectory(file.root, input, environment, `File "${file.relativePath}"`);
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
  reporter.log("file", `${target} (${bytes.byteLength} bytes, ${file.format})\n\n${clip(text, 16_384)}`);
  if (file.format === "text") {
    return { relativePath: file.relativePath, content: text };
  }
  try {
    return { relativePath: file.relativePath, content: JSON.parse(text) as JsonValue };
  } catch (error) {
    throw new Error(`File "${file.relativePath}" is not valid JSON.`, { cause: error });
  }
}
