/** A directory Environment, optionally narrowed to one sub-directory named by a string Input
    (the Environment is the place where all projects live; the Input picks the project). */
export interface EnvironmentPath {
  readonly environment: string;
  readonly appendInput?: string;
}

/** One argv token: a literal, one string Input, or the TRUST execution identifier. */
export type ShellArgument =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "input"; readonly input: string; readonly prefix?: string }
  | { readonly kind: "execution"; readonly field: "id"; readonly prefix?: string };

/** Render one argv token without exposing runner internals to the Operation. */
export function renderShellArgument(
  argument: ShellArgument,
  resolveInput: (input: string) => string,
  resolveExecution: (field: "id") => string = () => {
    throw new TypeError("Operation Execution context is unavailable.");
  },
): string {
  if (argument.kind === "literal") return argument.value;
  const value = argument.kind === "input"
    ? resolveInput(argument.input)
    : resolveExecution(argument.field);
  return `${argument.prefix ?? ""}${value}`;
}

export interface AcceptedShellExit {
  readonly code: number;
  readonly stdoutContains?: string;
  readonly stderrContains?: string;
}

export interface Shell {
  readonly executable: string;
  readonly arguments: readonly ShellArgument[];
  readonly cwd: EnvironmentPath;
  readonly acceptedExits: readonly AcceptedShellExit[];
}
