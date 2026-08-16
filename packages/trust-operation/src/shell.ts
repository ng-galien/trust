/** A directory Environment, optionally narrowed to one sub-directory named by a string Input
    (the Environment is the place where all projects live; the Input picks the project). */
export interface EnvironmentPath {
  readonly environment: string;
  readonly appendInput?: string;
}

export type ShellArgument =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "input"; readonly input: string };

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
