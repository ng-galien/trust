import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { compileOperation, type CompiledOperation } from "@trust/operation";

export function readOperations(directory: string): readonly CompiledOperation[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".feature"))
    .sort()
    .map((name) => compileOperation({
      source: readFileSync(resolve(directory, name), "utf8"),
      sourceName: name,
    }));
}
