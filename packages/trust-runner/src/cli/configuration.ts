import { delimiter, isAbsolute } from "node:path";

export interface RunnerInvocationConfiguration {
  readonly additionalPath: readonly string[];
}

/** Remove repeatable runner-startup options from argv. The remaining argv contains only the Check
    invocation (CLI) or nothing (MCP stdio). */
export function readRunnerConfiguration(argv: string[]): RunnerInvocationConfiguration {
  const additionalPath: string[] = [];
  for (let index = 0; index < argv.length;) {
    if (argv[index] !== "--path") {
      index += 1;
      continue;
    }
    const value = argv[index + 1];
    if (!value || !isAbsolute(value) || value.includes("\0") || value.includes(delimiter)) {
      throw new TypeError("--path requires one absolute directory");
    }
    additionalPath.push(value);
    argv.splice(index, 2);
  }
  return { additionalPath };
}
