const ENVIRONMENT_NAME = /^[a-z][a-z0-9-]{0,62}$/;
const VALUE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;

export class EnvironmentConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvironmentConfigurationError";
  }
}

export function assertEnvironmentName(name: string): void {
  if (!ENVIRONMENT_NAME.test(name)) {
    throw new EnvironmentConfigurationError("Environment name must be a canonical slug");
  }
}

export function assertValueName(name: string): void {
  if (!VALUE_NAME.test(name)) {
    throw new EnvironmentConfigurationError("Environment value name must be an identifier");
  }
}

export function assertEnvironmentValues(values: Readonly<Record<string, string>>): void {
  for (const [name, value] of Object.entries(values)) {
    assertValueName(name);
    if (value.length === 0 || value.includes("\0")) {
      throw new EnvironmentConfigurationError(`Environment value "${name}" must be a non-empty string`);
    }
  }
}
