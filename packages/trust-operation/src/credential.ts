import { matchHttpHeaderSource, matchOperationStep } from "./match.js";
import type { CompiledOperation } from "./operation.js";

/** A value taken from one Credential declared by `Given Credentials`. */
export interface CredentialSource {
  readonly kind: "credential";
  readonly credential: string;
}

/** One place where a compiled Operation step consumes a declared Credential. */
export type OperationCredentialReference =
  | { readonly kind: "http-header"; readonly step: string; readonly header: string; readonly credential: string }
  | { readonly kind: "postgresql-authentication"; readonly step: string; readonly credential: string }
  | { readonly kind: "shell-variable"; readonly step: string; readonly variable: string; readonly credential: string };

/** The Credential names an Operation declares; TRUST resolves exactly these names at admission. */
export function operationCredentialNames(operation: CompiledOperation): readonly string[] {
  return operation.credentials ?? [];
}

/** Every Credential reference of the compiled steps, in step and source order. */
export function operationCredentialReferences(operation: CompiledOperation): readonly OperationCredentialReference[] {
  return operation.steps.flatMap((step) =>
    matchOperationStep<readonly OperationCredentialReference[]>(step, {
      shell: (shell) =>
        (shell.shell.variables ?? []).map((variable) => ({
          kind: "shell-variable" as const,
          step: shell.name,
          variable: variable.name,
          credential: variable.source.credential,
        })),
      "file-read": () => [],
      http: (http) =>
        http.http.headers.flatMap((header) =>
          matchHttpHeaderSource<readonly OperationCredentialReference[]>(header.source, {
            literal: () => [],
            input: () => [],
            environment: () => [],
            credential: (source) => [
              { kind: "http-header", step: http.name, header: header.name, credential: source.credential },
            ],
          }),
        ),
      postgresql: (postgresql) =>
        postgresql.postgresql.authentication
          ? [
              {
                kind: "postgresql-authentication" as const,
                step: postgresql.name,
                credential: postgresql.postgresql.authentication.credential,
              },
            ]
          : [],
    }),
  );
}

/** The declared Credential values an Environment provides, and the declared names it lacks. An
    Environment may hold more Credentials; only the declared ones are projected. */
export function projectOperationCredentials(
  operation: CompiledOperation,
  values: Readonly<Record<string, string>>,
): { credentials: Record<string, string>; missing: string[] } {
  const credentials: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of operationCredentialNames(operation)) {
    const value = Object.hasOwn(values, name) ? values[name] : undefined;
    if (value === undefined) missing.push(name);
    else credentials[name] = value;
  }
  return { credentials, missing };
}
