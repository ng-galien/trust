export interface EnvironmentPath {
  readonly environment: string;
}

export interface Shell {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly cwd: EnvironmentPath;
}
