import type { Clock } from "../time.js";
import {
  assertEnvironmentName,
  assertValueName,
  EnvironmentConfigurationError,
} from "../environment/validation.js";
import type { CredentialStore } from "./store.js";
import type { EnvironmentStore } from "../environment/store.js";

export interface CredentialReference {
  readonly environment: string;
  readonly name: string;
}

export class CredentialService {
  readonly #credentials = new Map<string, Map<string, string>>();

  constructor(private readonly dependencies: {
    readonly credentialStore: CredentialStore;
    readonly environmentStore: EnvironmentStore;
    readonly clock: Clock;
  }) {}

  async initialize(): Promise<void> {
    this.#credentials.clear();
    for (const credential of await this.dependencies.credentialStore.list()) {
      this.#environment(credential.environment).set(credential.name, credential.value);
    }
  }

  list(environment?: string): CredentialReference[] {
    if (environment !== undefined) assertEnvironmentName(environment);
    return [...this.#credentials]
      .filter(([environmentName]) => environment === undefined || environmentName === environment)
      .flatMap(([environmentName, credentials]) => [...credentials.keys()].map((name) => ({
        environment: environmentName,
        name,
      })))
      .sort((left, right) => `${left.environment}/${left.name}`.localeCompare(`${right.environment}/${right.name}`));
  }

  resolve(environment: string): Readonly<Record<string, string>> {
    return Object.fromEntries(this.#credentials.get(environment) ?? []);
  }

  async save(environment: string, name: string, value: string): Promise<CredentialReference> {
    assertEnvironmentName(environment);
    assertValueName(name);
    if (value.length === 0 || value.includes("\0")) {
      throw new EnvironmentConfigurationError("Credential value must be a non-empty string");
    }
    if (!await this.dependencies.environmentStore.exists(environment)) {
      throw new EnvironmentConfigurationError(`Environment "${environment}" is not configured`);
    }
    await this.dependencies.credentialStore.save(
      environment,
      name,
      value,
      this.dependencies.clock.now().toISOString(),
    );
    this.#environment(environment).set(name, value);
    return { environment, name };
  }

  async remove(environment: string, name: string): Promise<boolean> {
    assertEnvironmentName(environment);
    assertValueName(name);
    const removed = await this.dependencies.credentialStore.remove(environment, name);
    if (removed) this.#credentials.get(environment)?.delete(name);
    return removed;
  }

  forgetEnvironment(environment: string): void {
    this.#credentials.delete(environment);
  }

  #environment(name: string): Map<string, string> {
    const existing = this.#credentials.get(name);
    if (existing) return existing;
    const created = new Map<string, string>();
    this.#credentials.set(name, created);
    return created;
  }
}
