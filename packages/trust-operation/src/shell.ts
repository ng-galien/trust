export interface EnvironmentPath {
  readonly environment: string;
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
