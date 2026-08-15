import type { EnvironmentPath } from "./shell.js";
import type { JsonValue } from "./json.js";

export type FileFormat = "text" | "json";

export interface FileRead {
  readonly relativePath: string;
  readonly root: EnvironmentPath;
  readonly format: FileFormat;
}

export interface FileTextResult {
  readonly relativePath: string;
  readonly content: string;
}

export interface FileJsonResult {
  readonly relativePath: string;
  readonly content: JsonValue;
}
