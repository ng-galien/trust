import {
  type AccessContext,
  type ExtensionCapability,
  ExtensionTrustError,
  type Installation,
} from "@trust/extension-sdk";
import { AccessError } from "../access/error.js";
import type { AccessService } from "../access/service.js";
import { parsePlanDeclarationReplacement } from "../http/plan.js";
import type { OperationCatalog } from "../operation/catalog.js";
import { type PlanReader, ReadError } from "../plan/read.js";
import { type PlanRuntime, PlanRuntimeError } from "../plan/runtime.js";
import type { Procedures } from "../procedure/procedures.js";
import { listExtensionPlans, parseExtensionPlanSelection } from "./plan-selection.js";

const identifier = (value: unknown) =>
  typeof value === "string" && value.length > 0 && value.length <= 200 ? value : undefined;

function exact(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ExtensionTrustError("invalid-request");
  const record = input as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some((key) => !Object.hasOwn(record, key)))
    throw new ExtensionTrustError("invalid-request");
  return record;
}

/**
 * As on the extension page, a Plan outside the caller's rights is indistinguishable from a missing one; any other
 * failure is reported as unavailable, never as a missing Plan.
 */
function hidden(error: unknown): never {
  if (error instanceof AccessError || (error instanceof ReadError && error.code === "plan-not-found"))
    throw new ExtensionTrustError("not-found");
  throw new ExtensionTrustError("unavailable");
}

function required(value: unknown): string {
  const found = identifier(value);
  if (found === undefined) throw new ExtensionTrustError("invalid-request");
  return found;
}

/**
 * Server-side TRUST surfaces of an extension. Each call runs with the access of the invocation in progress and the
 * installation grants, confined to the installation environment, exactly as the extension page's TRUST surfaces.
 */
export class ExtensionTrustGateway {
  constructor(
    private readonly dependencies: {
      accessService: AccessService;
      planReader: PlanReader;
      planRuntime: PlanRuntime;
      operationCatalog: OperationCatalog;
      procedures: Procedures;
    },
  ) {}

  async call(installation: Installation, method: unknown, input: unknown, access: AccessContext | undefined) {
    try {
      // A declaration replacement writes in TRUST; every other surface reads.
      const right = method === "plans.declarations.replace" ? "write" : "read";
      this.dependencies.accessService.authorizeExtension(access, installation.id, right);
      return await this.#dispatch(installation, method, input, access);
    } catch (error) {
      if (error instanceof ExtensionTrustError) throw error;
      if (error instanceof AccessError) throw new ExtensionTrustError("access-denied");
      if (error instanceof PlanRuntimeError) throw new ExtensionTrustError("refused", error.message);
      throw new ExtensionTrustError("unavailable");
    }
  }

  async #dispatch(installation: Installation, method: unknown, input: unknown, access: AccessContext | undefined) {
    const grant = (capability: ExtensionCapability) => {
      if (!installation.grants.includes(capability)) throw new ExtensionTrustError("capability-denied");
    };
    const { planReader, planRuntime, operationCatalog, procedures, accessService } = this.dependencies;
    const livePlan = async (slug: string) => {
      const plan = await planReader.readLivePlanBySlug(slug, access).catch(hidden);
      if (plan.environment !== installation.environment) throw new ExtensionTrustError("not-found");
      return plan;
    };
    switch (method) {
      case "plans.list": {
        const selection = parseExtensionPlanSelection(input);
        if (selection === undefined) throw new ExtensionTrustError("invalid-request");
        grant("plans.read");
        return listExtensionPlans(planReader, installation.environment, selection, access);
      }
      case "plans.read": {
        const { plan } = exact(input, ["plan"]);
        grant("plans.read");
        return livePlan(required(plan));
      }
      case "episodes.read": {
        const { plan } = exact(input, ["plan"]);
        grant("plans.read");
        const episode = await planReader.readDelegationEpisode(required(plan), access).catch(hidden);
        if (
          episode.root.plan.environment !== installation.environment ||
          episode.branches.some(({ child }) => child && child.plan.environment !== installation.environment)
        )
          throw new ExtensionTrustError("not-found");
        return episode;
      }
      case "plans.declarations.replace": {
        grant("plans.declare");
        let request: ReturnType<typeof parsePlanDeclarationReplacement>;
        try {
          request = parsePlanDeclarationReplacement(input);
        } catch {
          throw new ExtensionTrustError("invalid-request");
        }
        await livePlan(request.plan);
        return planRuntime.replaceDeclarations(request, access);
      }
      case "procedures.read": {
        const { procedure, version } = exact(input, ["procedure", "version"]);
        grant("catalog.read");
        accessService.authorize(access, "procedure.read");
        const published = await procedures.find(required(procedure), required(version));
        if (!published) throw new ExtensionTrustError("not-found");
        return published.procedure;
      }
      case "operations.read": {
        const { operation, version } = exact(input, ["operation", "version"]);
        grant("catalog.read");
        accessService.authorize(access, "operation.read");
        const found = operationCatalog.find(required(operation), required(version));
        if (!found) throw new ExtensionTrustError("not-found");
        return found;
      }
      default:
        throw new ExtensionTrustError("invalid-request");
    }
  }
}
