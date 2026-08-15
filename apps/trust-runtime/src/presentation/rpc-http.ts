import express, {
  type ErrorRequestHandler,
  type RequestHandler,
  type Router,
} from "express";
import {
  type compileAutonomousProcedureDefinition,
  ProcedureCompilationError,
} from "@trust/procedure";

import {
  AgentReadError,
  type AgentReadService,
} from "../application/agent-read-service.js";
import type { ProcedureDefinitionService } from "../application/procedure-definition-service.js";
import { ProcedureDefinitionConflictError } from "../infrastructure/repositories/procedure-definition-repository.js";
import {
  PlanRuntimeError,
  type PlanRuntimeService,
} from "../application/plan-runtime-service.js";
import type { SkillPreflightService } from "../application/skill-preflight-service.js";
import type { SkillRegistryService } from "../application/skill-registry-service.js";
import { SkillRegistryError, type SkillRegistryErrorCode } from "../domain/skill-registry.js";
import type { Clock } from "../ports/clock.js";
import {
  RegistryAuthorityError,
  type RegistryAuthority,
} from "../ports/registry-authority.js";
import {
  PROCEDURE_COMPILATION_ERROR_CONTRACT,
  PROCEDURE_DEFINITION_COMPILE_METHOD,
  PROCEDURE_DEFINITION_PUBLISH_METHOD,
  PROCEDURE_DEFINITION_READ_METHOD,
  PLAN_RUNTIME_ERROR_CONTRACT,
  type JsonRpcFailure,
  type JsonRpcId,
  type JsonRpcResponse,
  type ProcedureCompilationFailureData,
  type ProcedureDefinitionCompileParams,
  type ProcedureDefinitionCompileResultV2,
  type ProcedureDefinitionReadParams,
  type PlanRuntimeFailureData,
  projectAutonomousCompiledDefinition,
  REGISTRY_AUTHORITY_ERROR_CONTRACT,
  type RegistryAuthorityFailureData,
  SKILL_REGISTRY_ERROR_CONTRACT,
  type SkillRegistryFailureData,
  type SkillRegistryFailureReason,
} from "./rpc-contract.js";
import {
  executePlanRuntimeRpc,
  InvalidPlanRuntimeRpcParams,
  isPlanRuntimeRpcMethod,
} from "./plan-runtime-rpc.js";
import {
  executeSkillRegistryRpc,
  InvalidSkillRegistryRpcParams,
  isSkillRegistryRpcMethod,
} from "./skill-registry-rpc.js";

export const RPC_JSON_LIMIT_BYTES = 1_048_576;

const PARSE_ERROR = -32_700;
const INVALID_REQUEST = -32_600;
const METHOD_NOT_FOUND = -32_601;
const INVALID_PARAMS = -32_602;
const INTERNAL_ERROR = -32_603;
const PROCEDURE_COMPILATION_ERROR = -32_010;
const SKILL_REGISTRY_ERROR = -32_020;
const REGISTRY_AUTHORITY_ERROR = -32_021;
const PLAN_RUNTIME_ERROR = -32_030;

interface RpcHttpDependencies {
  readonly agentReadService: AgentReadService;
  readonly clock: Clock;
  readonly procedureDefinitionCompiler: typeof compileAutonomousProcedureDefinition;
  readonly procedureDefinitionService: ProcedureDefinitionService;
  readonly planRuntimeService: PlanRuntimeService;
  readonly registryAuthority: RegistryAuthority;
  readonly skillPreflightService: SkillPreflightService;
  readonly skillRegistryService: SkillRegistryService;
}

type RpcErrorData =
  | ProcedureCompilationFailureData
  | PlanRuntimeFailureData
  | RegistryAuthorityFailureData
  | SkillRegistryFailureData;
type RpcResult = JsonRpcResponse<unknown, RpcErrorData>;

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasOnlyKeys = (value: Record<string, unknown>, allowed: readonly string[]): boolean => {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
};

const isJsonRpcId = (value: unknown): value is JsonRpcId =>
  value === null || typeof value === "string" || typeof value === "number";

const failure = <Data = unknown>(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: Data,
): JsonRpcFailure<Data> => ({
  jsonrpc: "2.0",
  id,
  error: {
    code,
    message,
    ...(data === undefined ? {} : { data }),
  },
});

const compileParams = (value: unknown): ProcedureDefinitionCompileParams | undefined => {
  if (!isRecord(value)) return undefined;
  const allowed = new Set(["source", "sourceName"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return undefined;
  if (typeof value.source !== "string") return undefined;
  if (hasOwn(value, "sourceName") && typeof value.sourceName !== "string") return undefined;
  return {
    source: value.source,
    ...(typeof value.sourceName === "string" ? { sourceName: value.sourceName } : {}),
  };
};

const readParams = (value: unknown): ProcedureDefinitionReadParams | undefined => {
  if (!isRecord(value) || !hasOnlyKeys(value, ["procedure", "version"])) return undefined;
  if (
    typeof value.procedure !== "string"
    || value.procedure.length === 0
    || typeof value.version !== "string"
    || value.version.length === 0
  ) return undefined;
  return { procedure: value.procedure, version: value.version };
};

const sourceNameFrom = (params: ProcedureDefinitionCompileParams): string =>
  params.sourceName ?? "<procedure>";

const processMessage = (
  message: unknown,
  dependencies: RpcHttpDependencies,
  authorizationHeader: string | undefined,
  processAuthorizationHeader: string | undefined,
): RpcResult | undefined => {
  if (!isRecord(message)) return failure(null, INVALID_REQUEST, "Invalid Request");

  const hasId = hasOwn(message, "id");
  if (hasId && !isJsonRpcId(message.id)) {
    return failure(null, INVALID_REQUEST, "Invalid Request");
  }
  const id = hasId ? (message.id as JsonRpcId) : null;
  if (message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return failure(id, INVALID_REQUEST, "Invalid Request");
  }

  const respond = <Response extends RpcResult>(response: Response): Response | undefined =>
    hasId ? response : undefined;

  if (
    message.method !== PROCEDURE_DEFINITION_COMPILE_METHOD &&
    message.method !== PROCEDURE_DEFINITION_PUBLISH_METHOD &&
    message.method !== PROCEDURE_DEFINITION_READ_METHOD &&
    !isPlanRuntimeRpcMethod(message.method) &&
    !isSkillRegistryRpcMethod(message.method)
  ) {
    return respond(failure(id, METHOD_NOT_FOUND, "Method not found"));
  }

  if (message.method === PROCEDURE_DEFINITION_COMPILE_METHOD) {
    const params = compileParams(message.params);
    if (!params) return respond(failure(id, INVALID_PARAMS, "Invalid params"));
    try {
      const result = projectAutonomousCompiledDefinition(
        dependencies.procedureDefinitionCompiler(params),
      );
      return respond({ jsonrpc: "2.0", id, result });
    } catch (error) {
      if (error instanceof ProcedureCompilationError) {
        const data: ProcedureCompilationFailureData = {
          contract: PROCEDURE_COMPILATION_ERROR_CONTRACT,
          reason: error.code,
          message: error.message,
          sourceName: error.sourceName ?? sourceNameFrom(params),
          location: error.location ?? null,
        };
        return respond(
          failure(id, PROCEDURE_COMPILATION_ERROR, "Procedure definition rejected", data),
        );
      }
      return respond(failure(id, INTERNAL_ERROR, "Internal error"));
    }
  }

  if (message.method === PROCEDURE_DEFINITION_PUBLISH_METHOD) {
    const params = compileParams(message.params);
    if (!params) return respond(failure(id, INVALID_PARAMS, "Invalid params"));
    try {
      const principal = dependencies.registryAuthority.authorize({
        ...(authorizationHeader === undefined ? {} : { authorizationHeader }),
        anyRoleOf: ["publisher"],
      });
      const published = dependencies.procedureDefinitionService.publish(params, principal.identity);
      return respond({
        jsonrpc: "2.0",
        id,
        result: {
          contract: "trust.published-procedure@1",
          definition: projectAutonomousCompiledDefinition(published.definition),
          sourceName: published.sourceName,
          publishedBy: published.publishedBy,
          publishedAt: published.publishedAt,
        },
      });
    } catch (error) {
      if (error instanceof ProcedureCompilationError) {
        const data: ProcedureCompilationFailureData = {
          contract: PROCEDURE_COMPILATION_ERROR_CONTRACT,
          reason: error.code,
          message: error.message,
          sourceName: error.sourceName ?? sourceNameFrom(params),
          location: error.location ?? null,
        };
        return respond(failure(id, PROCEDURE_COMPILATION_ERROR, "Procedure definition rejected", data));
      }
      if (error instanceof RegistryAuthorityError) {
        const data: RegistryAuthorityFailureData = {
          contract: REGISTRY_AUTHORITY_ERROR_CONTRACT,
          reason: error.reason,
          message: error.message,
        };
        return respond(failure(id, REGISTRY_AUTHORITY_ERROR, "Registry authority denied", data));
      }
      if (error instanceof ProcedureDefinitionConflictError) {
        return respond(failure(id, PROCEDURE_COMPILATION_ERROR, "Procedure publication rejected", {
          contract: PROCEDURE_COMPILATION_ERROR_CONTRACT,
          reason: "invalid-procedure",
          message: error.message,
          sourceName: sourceNameFrom(params),
          location: null,
        } satisfies ProcedureCompilationFailureData));
      }
      return respond(failure(id, INTERNAL_ERROR, "Internal error"));
    }
  }

  if (message.method === PROCEDURE_DEFINITION_READ_METHOD) {
    const params = readParams(message.params);
    if (!params) return respond(failure(id, INVALID_PARAMS, "Invalid params"));
    try {
      dependencies.registryAuthority.authorize({
        ...(authorizationHeader === undefined ? {} : { authorizationHeader }),
        anyRoleOf: ["observer", "operator", "publisher"],
      });
      const published = dependencies.procedureDefinitionService.find(params.procedure, params.version);
      if (!published) return respond(failure(id, PROCEDURE_COMPILATION_ERROR, "Procedure not found"));
      return respond({
        jsonrpc: "2.0",
        id,
        result: {
          contract: "trust.published-procedure@1",
          definition: projectAutonomousCompiledDefinition(published.definition),
          sourceName: published.sourceName,
          publishedBy: published.publishedBy,
          publishedAt: published.publishedAt,
        },
      });
    } catch (error) {
      if (error instanceof RegistryAuthorityError) {
        const data: RegistryAuthorityFailureData = {
          contract: REGISTRY_AUTHORITY_ERROR_CONTRACT,
          reason: error.reason,
          message: error.message,
        };
        return respond(failure(id, REGISTRY_AUTHORITY_ERROR, "Registry authority denied", data));
      }
      return respond(failure(id, INTERNAL_ERROR, "Internal error"));
    }
  }

  try {
    const context = {
      ...(authorizationHeader === undefined ? {} : { authorizationHeader }),
      ...(processAuthorizationHeader === undefined
        ? {}
        : { processAuthorizationHeader }),
    };
    const result = isPlanRuntimeRpcMethod(message.method)
      ? executePlanRuntimeRpc(message.method, message.params, dependencies, context)
      : executeSkillRegistryRpc(message.method, message.params, dependencies, context);
    return respond({ jsonrpc: "2.0", id, result });
  } catch (error) {
    if (error instanceof InvalidPlanRuntimeRpcParams) {
      return respond(failure(id, INVALID_PARAMS, "Invalid params"));
    }
    if (error instanceof InvalidSkillRegistryRpcParams) {
      return respond(failure(id, INVALID_PARAMS, "Invalid params"));
    }
    if (error instanceof RegistryAuthorityError) {
      const data: RegistryAuthorityFailureData = {
        contract: REGISTRY_AUTHORITY_ERROR_CONTRACT,
        reason: error.reason,
        message: error.message,
      };
      return respond(failure(id, REGISTRY_AUTHORITY_ERROR, "Registry authority denied", data));
    }
    if (error instanceof SkillRegistryError) {
      const data: SkillRegistryFailureData = {
        contract: SKILL_REGISTRY_ERROR_CONTRACT,
        reason: projectSkillRegistryFailure(error.code),
        message: error.message,
      };
      return respond(failure(id, SKILL_REGISTRY_ERROR, "Skill registry rejected", data));
    }
    if (error instanceof PlanRuntimeError) {
      const data: PlanRuntimeFailureData = {
        contract: PLAN_RUNTIME_ERROR_CONTRACT,
        reason: error.code,
        message: error.message,
      };
      return respond(failure(id, PLAN_RUNTIME_ERROR, "Plan runtime rejected", data));
    }
    if (error instanceof AgentReadError) {
      const data: PlanRuntimeFailureData = {
        contract: PLAN_RUNTIME_ERROR_CONTRACT,
        reason: "check-not-found",
        message: error.message,
      };
      return respond(failure(id, PLAN_RUNTIME_ERROR, "Plan runtime rejected", data));
    }
    return respond(failure(id, INTERNAL_ERROR, "Internal error"));
  }
};

const dispatch = (
  body: unknown,
  dependencies: RpcHttpDependencies,
  authorizationHeader: string | undefined,
  processAuthorizationHeader: string | undefined,
): RpcResult | RpcResult[] | undefined => {
  if (!Array.isArray(body)) {
    return processMessage(
      body,
      dependencies,
      authorizationHeader,
      processAuthorizationHeader,
    );
  }
  if (body.length === 0) return failure(null, INVALID_REQUEST, "Invalid Request");
  const responses = body
    .map((message) =>
      processMessage(
        message,
        dependencies,
        authorizationHeader,
        processAuthorizationHeader,
      ),
    )
    .filter((response): response is RpcResult => response !== undefined);
  return responses.length > 0 ? responses : undefined;
};

const bodyParserFailure: ErrorRequestHandler = (error, _request, response, next) => {
  if (!isRecord(error)) {
    next(error);
    return;
  }
  if (error.type === "entity.too.large") {
    response.status(413).json(
      failure(null, INVALID_REQUEST, "Invalid Request", {
        reason: "payload-too-large",
        limitBytes: RPC_JSON_LIMIT_BYTES,
      }),
    );
    return;
  }
  if (error.type === "entity.parse.failed" || error instanceof SyntaxError) {
    response.status(400).json(failure(null, PARSE_ERROR, "Parse error"));
    return;
  }
  response.status(500).json(failure(null, INTERNAL_ERROR, "Internal error"));
};

export const createRpcHttpHandler = (dependencies: RpcHttpDependencies): Router => {
  const router = express.Router();
  const handle: RequestHandler = (request, response) => {
    const result = dispatch(
      request.body,
      dependencies,
      request.get("authorization"),
      request.get("x-trust-process-authorization"),
    );
    if (result === undefined) {
      response.status(204).end();
      return;
    }
    response.status(200).json(result);
  };

  router.post(
    "/",
    express.json({
      limit: RPC_JSON_LIMIT_BYTES,
      strict: false,
      type: ["application/json", "application/*+json"],
    }),
    handle,
  );
  router.use(bodyParserFailure);
  return router;
};

function projectSkillRegistryFailure(code: SkillRegistryErrorCode): SkillRegistryFailureReason {
  switch (code) {
    case "release-digest-collision":
      return "release-digest-conflict";
    case "release-version-collision":
      return "release-version-conflict";
    case "unknown-release":
      return "unknown-release";
    case "distribution-digest-collision":
      return "untrusted-distribution";
    case "deployment-already-active":
      return "deployment-lease-conflict";
    case "deployment-announcement-future":
      return "announcement-clock-skew";
    case "deployment-announcement-non-monotonic":
      return "announcement-not-monotonic";
    case "deployment-lease-too-long":
      return "invalid-lease";
    case "invalid-release-claim":
    case "invalid-requirement":
    case "invalid-distribution":
    case "invalid-authorization":
    case "invalid-selection":
    case "invalid-deployment-announcement":
      return "invalid-record";
  }
}
