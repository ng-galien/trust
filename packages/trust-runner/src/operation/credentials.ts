import { type CompiledOperation, type JsonValue, operationCredentialNames } from "@trust/operation";
import type { DiagnosticEvent, DiagnosticsSink } from "../diagnostics/events.js";

/** Credentials TRUST delegated for one admitted attempt. A value reaches only the step that
    references it by name; every Runner output is masked with `mask` before it leaves the step. */
export class DelegatedCredentials {
  readonly #values: ReadonlyMap<string, string>;
  readonly #masked: readonly (readonly [string, string])[];

  private constructor(values: ReadonlyMap<string, string>) {
    this.#values = values;
    this.#masked = [...values]
      .filter(([, value]) => value !== "")
      .sort(([, left], [, right]) => right.length - left.length)
      .map(([name, value]) => [value, `[credential ${name}]`] as const);
  }

  static none(): DelegatedCredentials {
    return new DelegatedCredentials(new Map());
  }

  /** Keep exactly the Credentials the Operation declares; a declared name TRUST did not delegate
      refuses the run before any step acts. */
  static forOperation(
    operation: CompiledOperation,
    delegated: Readonly<Record<string, string>> | undefined,
  ): DelegatedCredentials {
    const values = new Map<string, string>();
    const available = delegated ?? {};
    for (const name of operationCredentialNames(operation)) {
      const value = Object.hasOwn(available, name) ? available[name] : undefined;
      if (typeof value !== "string") {
        throw new TypeError(
          `Operation "${operation.operation}" declares Credential "${name}", which TRUST did not delegate for this attempt.`,
        );
      }
      values.set(name, value);
    }
    return new DelegatedCredentials(values);
  }

  resolve(name: string, label: string): string {
    const value = this.#values.get(name);
    if (value === undefined) throw new TypeError(`${label} references Credential "${name}", which was not delegated.`);
    return value;
  }

  mask(text: string): string {
    let masked = text;
    for (const [value, replacement] of this.#masked) masked = masked.replaceAll(value, replacement);
    return masked;
  }

  maskValue<T extends JsonValue | undefined>(value: T): T {
    if (this.#masked.length === 0) return value;
    return this.#maskAny(value) as T;
  }

  maskError(error: unknown): unknown {
    if (this.#masked.length === 0) return error;
    if (!(error instanceof Error)) return this.mask(String(error));
    const message = this.mask(error.message);
    const stack = error.stack === undefined ? undefined : this.mask(error.stack);
    if (message === error.message && stack === error.stack) return error;
    const masked = new Error(message);
    masked.name = error.name;
    if (stack !== undefined) masked.stack = stack;
    return masked;
  }

  sink(inner: DiagnosticsSink): DiagnosticsSink {
    if (this.#masked.length === 0) return inner;
    return {
      emit: (event) => inner.emit(this.#maskAny(event) as DiagnosticEvent),
      flush: () => inner.flush(),
    };
  }

  #maskAny(value: unknown): unknown {
    if (typeof value === "string") return this.mask(value);
    if (Array.isArray(value)) return value.map((entry) => this.#maskAny(entry));
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [this.mask(key), this.#maskAny(entry)]));
    }
    return value;
  }
}
