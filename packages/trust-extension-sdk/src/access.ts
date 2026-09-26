/** Stable external identity. Credentials and OAuth client IDs never own Plans. */
export interface ExternalPrincipal {
  readonly issuer: string;
  readonly subject: string;
}

/** Server-created request context. Never accepted from request JSON. */
export type AccessContext =
  | { readonly mode: "local" }
  | {
      readonly mode: "authenticated";
      readonly principal: ExternalPrincipal;
      readonly clientId?: string;
      readonly scopes: readonly string[];
      /** Unix seconds, not milliseconds. */
      readonly expiresAt: number;
      readonly verifiedAt: number;
      readonly verification: "local-jwt" | "introspection";
    };

export const PLAN_ACCESS_ACTIONS = [
  "plan.list",
  "plan.read",
  "plan.engage",
  "plan.declarations.replace",
  "plan.close",
  "plan.resume",
  "plan.reset",
  "plan.remove",
  "check.read",
  "check.escalate",
  "check.attempt.admit",
  "check.attempt.facts",
  "check.attempt.finalize",
  "check.attempt.interrupt",
  "session.read",
  "history.list",
] as const;

export const RESOURCE_ACCESS_ACTIONS = [
  "procedure.list",
  "procedure.read",
  "procedure.compile",
  "procedure.publish",
  "operation.list",
  "operation.read",
  "operation.compile",
  "operation.simulate",
  "operation.save",
  "operation.environments",
  "operation.trial.list",
  "operation.trial.read",
  "operation.trial.start",
  "operation.trial.cancel",
  "catalog.metadata.read",
  "catalog.metadata.history",
  "catalog.metadata.update",
  "template.list",
  "template.read",
  "template.save",
  "template.remove",
  "template.render",
  "environment.list",
  "environment.save",
  "environment.remove",
  "credential.list",
  "credential.save",
  "credential.remove",
  "registry.source.list",
  "registry.source.save",
  "registry.source.remove",
  "registry.source.sync",
  "extension.list",
  "extension.status",
  "extension.prepare",
  "extension.start",
  "extension.stop",
  "extension.restart",
  "documentation.list",
  "documentation.read",
] as const;

export type PlanAccessAction = (typeof PLAN_ACCESS_ACTIONS)[number];
export type ResourceAccessAction = (typeof RESOURCE_ACCESS_ACTIONS)[number];
export type ExtensionUseAction = `extension.${string}.use`;
export type AccessAction = PlanAccessAction | ResourceAccessAction | ExtensionUseAction;
export type PlanAccessScope = "own" | "all";

/** The exact installed extension identity owns this permission; no wildcard or lifecycle grant. */
export function extensionUseScope(extensionId: string): string {
  if (!/^[a-z][a-z0-9-]*$/.test(extensionId)) throw new TypeError("Invalid extension identity");
  return `trust.extension.${extensionId}.use`;
}
