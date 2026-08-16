import type { CredentialService } from "../credential/service.js";
import type { Clock } from "../time.js";
import type { EnvironmentStore } from "./store.js";
import {
  assertEnvironmentName,
  assertEnvironmentValues,
} from "./validation.js";

export type EnvironmentValues = Readonly<Record<string, string>>;

export interface EnvironmentView {
  readonly name: string;
  readonly values: EnvironmentValues;
}

export interface EnvironmentServiceDependencies {
  readonly environmentStore: EnvironmentStore;
  readonly credentialService: CredentialService;
  readonly clock: Clock;
}

export class EnvironmentService {
  readonly #environments = new Map<string, EnvironmentValues>();

  constructor(private readonly dependencies: EnvironmentServiceDependencies) {}

  async initialize(): Promise<void> {
    const stored = await this.dependencies.environmentStore.list();
    this.#environments.clear();
    for (const environment of stored) {
      this.#environments.set(environment.name, environment.values);
    }
  }

  list(): EnvironmentView[] {
    return [...this.#environments]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, values]) => ({ name, values: { ...values } }));
  }

  resolve(name: string): EnvironmentValues | undefined {
    const values = this.#environments.get(name);
    return values === undefined ? undefined : { ...values };
  }

  async save(name: string, values: EnvironmentValues): Promise<EnvironmentView> {
    assertEnvironmentName(name);
    assertEnvironmentValues(values);
    const copy = { ...values };
    await this.dependencies.environmentStore.save(
      name,
      copy,
      this.dependencies.clock.now().toISOString(),
    );
    this.#environments.set(name, copy);
    return { name, values: { ...copy } };
  }

  async remove(name: string): Promise<boolean> {
    assertEnvironmentName(name);
    const removed = await this.dependencies.environmentStore.remove(name);
    if (removed) {
      this.#environments.delete(name);
      this.dependencies.credentialService.forgetEnvironment(name);
    }
    return removed;
  }
}
