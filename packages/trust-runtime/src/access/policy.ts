import {
  type AccessContext,
  type ExternalPrincipal,
  PLAN_ACCESS_ACTIONS,
  type PlanAccessScope,
  RESOURCE_ACCESS_ACTIONS,
} from "@trust/extension-sdk";
import { matchAccessContext } from "@trust/extension-sdk/match";
import { AccessError } from "./error.js";

const planActions: ReadonlySet<string> = new Set(PLAN_ACCESS_ACTIONS);
const resourceActions: ReadonlySet<string> = new Set(RESOURCE_ACCESS_ACTIONS);

export const samePrincipal = (left: ExternalPrincipal | null, right: ExternalPrincipal | null): boolean =>
  left !== null && right !== null && left.issuer === right.issuer && left.subject === right.subject;

export function assertKnownAction(action: string): void {
  if (!planActions.has(action) && !resourceActions.has(action) && !/^extension\.[a-z][a-z0-9-]*\.use$/.test(action))
    throw new AccessError("forbidden", "Unknown access action");
}

export function accessPlanScope(context: AccessContext, action: string): PlanAccessScope {
  if (!planActions.has(action)) throw new AccessError("forbidden", "Action has no Plan scope");
  return matchAccessContext<PlanAccessScope>(context, {
    local: () => "all",
    authenticated: ({ scopes }) => {
      if (scopes.includes(`trust.${action}.all`)) return "all";
      if (scopes.includes(`trust.${action}.own`)) return "own";
      throw new AccessError("forbidden", "Required action permission is missing");
    },
  });
}

/** Fixed action/ownership policy; token validation and context provenance belong to AccessService. */
export function authorizeAccess(context: AccessContext, action: string, owner?: ExternalPrincipal | null): void {
  matchAccessContext(context, {
    local: () => undefined,
    authenticated: (authenticated) => {
      assertKnownAction(action);
      if (planActions.has(action)) {
        const scope = accessPlanScope(authenticated, action);
        if (owner !== undefined && scope === "own" && !samePrincipal(authenticated.principal, owner)) {
          throw new AccessError("forbidden", "The action requires access to this Plan's creator scope");
        }
      } else if (!authenticated.scopes.includes(`trust.${action}`)) {
        throw new AccessError("forbidden", "Required action permission is missing");
      }
    },
  });
}
