/** A directory Environment, optionally narrowed to one sub-directory named by a string Input
    (the Environment is the place where all projects live; the Input picks the project). */
export interface EnvironmentPath {
  readonly environment: string;
  readonly appendInput?: string;
}

/** One argv token: a literal, one string Input, or a literal prefix glued to one string Input
    (`literal + Input "x"`: the token is `<prefix><value>`, no separator). */
export type ShellArgument =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "input"; readonly input: string; readonly prefix?: string };

/** The argv token of one argument: the literal, or the prefix glued to the resolved Input value. */
export function renderShellArgument(argument: ShellArgument, resolve: (input: string) => string): string {
  return argument.kind === "literal" ? argument.value : `${argument.prefix ?? ""}${resolve(argument.input)}`;
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
