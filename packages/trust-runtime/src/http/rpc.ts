import express, {
  type ErrorRequestHandler,
  type RequestHandler,
  type Router,
} from "express";
import {
  CatalogProcedureCompilationError,
  type ProcedureCompilationErrorCode,
} from "@trust/procedure";
import {
  compileOperation,
  OperationCompilationError,
  OperationValidationError,
  simulateOperation,
} from "@trust/operation";

import {
  ReadError,
  type PlanReader,
} from "../plan/read.js";
import type { Procedures } from "../procedure/procedures.js";
import { ProcedureConflictError } from "../procedure/store.js";
import {
  PlanRuntimeError,
  type PlanRuntime,
} from "../plan/runtime.js";
import type { EnvironmentService } from "../environment/service.js";
import type { CredentialService } from "../credential/service.js";
import { EnvironmentConfigurationError } from "../environment/validation.js";
import { OperationCatalogError, type OperationCatalog } from "../operation/catalog.js";
import { TrialError, type TrialService } from "../trial/service.js";
import { executeTrialRpc, InvalidTrialRpcParams, isTrialRpcMethod, TRIAL_ERROR_CONTRACT, type TrialFailureData } from "./trial.js";
import {
  PLAN_RUNTIME_ERROR_CONTRACT,
  type PlanRuntimeFailureData,
} from "./plan.js";
import {
  executePlanRuntimeRpc,
  InvalidPlanRuntimeRpcParams,
  isPlanRuntimeRpcMethod,
} from "./plan.js";
import {
  executeConfigurationRpc,
  InvalidConfigurationRpcParams,
  isConfigurationRpcMethod,
} from "./configuration.js";

const PROCEDURE_COMPILE_METHOD = "procedure.compile" as const;
const PROCEDURE_PUBLISH_METHOD = "procedure.publish" as const;
const PROCEDURE_READ_METHOD = "procedure.read" as const;
const PROCEDURE_LIST_METHOD = "procedure.list" as const;
const OPERATION_COMPILE_METHOD = "operation.compile" as const;
const OPERATION_LIST_METHOD = "operation.list" as const;
const OPERATION_READ_METHOD = "operation.read" as const;
const OPERATION_SIMULATE_METHOD = "operation.simulate" as const;
const OPERATION_SAVE_METHOD = "operation.save" as const;
const OPERATION_REMOVE_METHOD = "operation.remove" as const;
const PROCEDURE_COMPILATION_ERROR_CONTRACT =
  "trust.procedure-compilation-error@1" as const;
const OPERATION_COMPILATION_ERROR_CONTRACT =
  "trust.operation-compilation-error@1" as const;

type JsonRpcId = string | number | null;

interface JsonRpcFailure<Data = unknown> {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly error: {
    readonly code: number;
    readonly message: string;
    readonly data?: Data;
  };
}

interface JsonRpcSuccess<Result = unknown> {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly result: Result;
}

type JsonRpcResponse<Result = unknown, ErrorData = unknown> =
  | JsonRpcSuccess<Result>
  | JsonRpcFailure<ErrorData>;

interface ProcedureCompileParams {
  readonly source: string;
  readonly sourceName?: string;
}

interface ProcedureReadParams {
  readonly procedure: string;
  readonly version: string;
}

interface OperationReadParams {
  readonly operation: string;
  readonly version: string;
}

interface OperationSimulationParams extends ProcedureCompileParams {
  readonly input: unknown;
  readonly environment: unknown;
  readonly steps: unknown;
}

interface ProcedureCompilationFailureData {
  readonly contract: typeof PROCEDURE_COMPILATION_ERROR_CONTRACT;
  readonly reason: ProcedureCompilationErrorCode;
  readonly message: string;
  readonly sourceName: string;
  readonly location: { readonly line: number; readonly column: number } | null;
}

interface OperationCompilationFailureData {
  readonly contract: typeof OPERATION_COMPILATION_ERROR_CONTRACT;
  readonly reason: string;
  readonly message: string;
  readonly sourceName: string;
  readonly location: { readonly line: number; readonly column: number } | null;
}

interface EnvironmentConfigurationFailureData {
  readonly contract: "trust.environment-configuration-error@1";
  readonly message: string;
}

export const RPC_JSON_LIMIT_BYTES = 1_048_576;

const PARSE_ERROR = -32_700;
const INVALID_REQUEST = -32_600;
const METHOD_NOT_FOUND = -32_601;
const INVALID_PARAMS = -32_602;
const INTERNAL_ERROR = -32_603;
const PROCEDURE_COMPILATION_ERROR = -32_010;
const PLAN_RUNTIME_ERROR = -32_030;
const TRIAL_ERROR = -32_040;

interface RpcHttpDependencies {
  readonly trialService: TrialService;
  readonly environmentService: EnvironmentService;
  readonly credentialService: CredentialService;
  readonly planReader: PlanReader;
  readonly procedures: Procedures;
  readonly operationCatalog: OperationCatalog;
  readonly planRuntime: PlanRuntime;
}

type RpcErrorData =
  | OperationCompilationFailureData
  | EnvironmentConfigurationFailureData
  | ProcedureCompilationFailureData
  | PlanRuntimeFailureData
  | TrialFailureData;
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

const compileParams = (value: unknown): ProcedureCompileParams | undefined => {
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

const readParams = (value: unknown): ProcedureReadParams | undefined => {
  if (!isRecord(value) || !hasOnlyKeys(value, ["procedure", "version"])) return undefined;
  if (
    typeof value.procedure !== "string"
    || value.procedure.length === 0
    || typeof value.version !== "string"
    || value.version.length === 0
  ) return undefined;
  return { procedure: value.procedure, version: value.version };
};

const listParams = (value: unknown): { readonly summary: boolean } | undefined => {
  if (!isRecord(value) || !hasOnlyKeys(value, ["summary"])) return undefined;
  if (value.summary !== undefined && typeof value.summary !== "boolean") return undefined;
  return { summary: value.summary === true };
};

const operationReadParams = (value: unknown): OperationReadParams | undefined => {
  if (!isRecord(value) || !hasOnlyKeys(value, ["operation", "version"])) return undefined;
  if (
    typeof value.operation !== "string"
    || value.operation.length === 0
    || typeof value.version !== "string"
    || value.version.length === 0
  ) return undefined;
  return { operation: value.operation, version: value.version };
};

const operationSimulationParams = (
  value: unknown,
): OperationSimulationParams | undefined => {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "source",
    "sourceName",
    "input",
    "environment",
    "steps",
  ])) return undefined;
  if (
    typeof value.source !== "string"
    || !Object.hasOwn(value, "input")
    || !Object.hasOwn(value, "environment")
    || !Object.hasOwn(value, "steps")
    || (Object.hasOwn(value, "sourceName") && typeof value.sourceName !== "string")
  ) return undefined;
  return {
    source: value.source,
    ...(typeof value.sourceName === "string" ? { sourceName: value.sourceName } : {}),
    input: value.input,
    environment: value.environment,
    steps: value.steps,
  };
};

const sourceNameFrom = (params: ProcedureCompileParams): string =>
  params.sourceName ?? "<procedure>";

const processMessage = async (
  message: unknown,
  dependencies: RpcHttpDependencies,
): Promise<RpcResult | undefined> => {
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
    message.method !== PROCEDURE_COMPILE_METHOD &&
    message.method !== PROCEDURE_PUBLISH_METHOD &&
    message.method !== PROCEDURE_READ_METHOD &&
    message.method !== PROCEDURE_LIST_METHOD &&
    message.method !== OPERATION_COMPILE_METHOD &&
    message.method !== OPERATION_LIST_METHOD &&
    message.method !== OPERATION_READ_METHOD &&
    message.method !== OPERATION_SIMULATE_METHOD &&
    message.method !== OPERATION_SAVE_METHOD &&
    message.method !== OPERATION_REMOVE_METHOD &&
    !isPlanRuntimeRpcMethod(message.method) &&
    !isConfigurationRpcMethod(message.method) &&
    !isTrialRpcMethod(message.method)
  ) {
    return respond(failure(id, METHOD_NOT_FOUND, "Method not found"));
  }

  if (isConfigurationRpcMethod(message.method)) {
    try {
      const result = await executeConfigurationRpc(message.method, message.params, dependencies);
      return respond({ jsonrpc: "2.0", id, result });
    } catch (error) {
      if (error instanceof InvalidConfigurationRpcParams) {
        return respond(failure(id, INVALID_PARAMS, "Invalid params"));
      }
      if (error instanceof EnvironmentConfigurationError) {
        return respond(failure(id, INVALID_PARAMS, "Invalid params", {
          contract: "trust.environment-configuration-error@1",
          message: error.message,
        } satisfies EnvironmentConfigurationFailureData));
      }
      process.stderr.write(`configuration rpc ${message.method} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      return respond(failure(id, INTERNAL_ERROR, "Internal error"));
    }
  }

  if (isTrialRpcMethod(message.method)) {
    try {
      const result = await executeTrialRpc(message.method, message.params, dependencies);
      return respond({ jsonrpc: "2.0", id, result });
    } catch (error) {
      if (error instanceof InvalidTrialRpcParams) return respond(failure(id, INVALID_PARAMS, "Invalid params"));
      if (error instanceof TrialError) {
        const data: TrialFailureData = {
          contract: TRIAL_ERROR_CONTRACT,
          reason: error.reason,
          message: error.message,
          ...(error.location ? { location: error.location } : {}),
        };
        return respond(failure(id, TRIAL_ERROR, "Trial rejected", data));
      }
      process.stderr.write(`trial rpc ${message.method} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      return respond(failure(id, INTERNAL_ERROR, "Internal error"));
    }
  }

  if (message.method === OPERATION_LIST_METHOD) {
    const params = listParams(message.params);
    if (!params) return respond(failure(id, INVALID_PARAMS, "Invalid params"));
    const operations = dependencies.operationCatalog.list();
    return respond({
      jsonrpc: "2.0",
      id,
      result: {
        contract: "trust.operation-catalog@1",
        operations: params.summary ? operations.map(operationSummary) : operations,
      },
    });
  }

  if (message.method === OPERATION_READ_METHOD) {
    const params = operationReadParams(message.params);
    if (!params) return respond(failure(id, INVALID_PARAMS, "Invalid params"));
    const operation = dependencies.operationCatalog.find(params.operation, params.version);
    return respond(operation === undefined
      ? failure(id, PROCEDURE_COMPILATION_ERROR, "Operation not found")
      : { jsonrpc: "2.0", id, result: operation });
  }

  if (message.method === OPERATION_SAVE_METHOD) {
    const params = compileParams(message.params);
    if (!params || params.sourceName === undefined) return respond(failure(id, INVALID_PARAMS, "Invalid params"));
    try {
      return respond({
        jsonrpc: "2.0",
        id,
        result: {
          contract: "trust.saved-operation@1",
          operation: await dependencies.operationCatalog.save(params.source, params.sourceName),
          sourceName: params.sourceName,
        },
      });
    } catch (error) {
      if (error instanceof OperationCompilationError || error instanceof OperationCatalogError) {
        return respond(failure(id, PROCEDURE_COMPILATION_ERROR, "Operation save rejected", {
          contract: OPERATION_COMPILATION_ERROR_CONTRACT,
          reason: error instanceof OperationCompilationError ? error.code : error.reason,
          message: error.message,
          sourceName: params.sourceName,
          location: error instanceof OperationCompilationError ? error.location ?? null : null,
        } satisfies OperationCompilationFailureData));
      }
      return respond(failure(id, INTERNAL_ERROR, "Internal error"));
    }
  }

  if (message.method === OPERATION_REMOVE_METHOD) {
    const params = operationReadParams(message.params);
    if (!params) return respond(failure(id, INVALID_PARAMS, "Invalid params"));
    try {
      await dependencies.operationCatalog.remove(params.operation, params.version);
      return respond({
        jsonrpc: "2.0",
        id,
        result: { contract: "trust.removed-operation@1", operation: params.operation, version: params.version, removed: true },
      });
    } catch (error) {
      if (error instanceof OperationCatalogError) {
        return respond(failure(id, PROCEDURE_COMPILATION_ERROR, "Operation removal rejected", {
          contract: OPERATION_COMPILATION_ERROR_CONTRACT,
          reason: error.reason,
          message: error.message,
          sourceName: "<operation>",
          location: null,
        } satisfies OperationCompilationFailureData));
      }
      return respond(failure(id, INTERNAL_ERROR, "Internal error"));
    }
  }

  if (message.method === OPERATION_COMPILE_METHOD) {
    const params = compileParams(message.params);
    if (!params) return respond(failure(id, INVALID_PARAMS, "Invalid params"));
    try {
      return respond({ jsonrpc: "2.0", id, result: compileOperation(params) });
    } catch (error) {
      if (error instanceof OperationCompilationError) {
        return respond(failure(id, PROCEDURE_COMPILATION_ERROR, "Operation rejected", {
          contract: OPERATION_COMPILATION_ERROR_CONTRACT,
          reason: error.code,
          message: error.message,
          sourceName: error.sourceName ?? params.sourceName ?? "<operation>",
          location: error.location ?? null,
        } satisfies OperationCompilationFailureData));
      }
      return respond(failure(id, INTERNAL_ERROR, "Internal error"));
    }
  }

  if (message.method === OPERATION_SIMULATE_METHOD) {
    const params = operationSimulationParams(message.params);
    if (!params) return respond(failure(id, INVALID_PARAMS, "Invalid params"));
    try {
      return respond({ jsonrpc: "2.0", id, result: await simulateOperation(params) });
    } catch (error) {
      if (error instanceof OperationCompilationError) {
        return respond(failure(id, PROCEDURE_COMPILATION_ERROR, "Operation rejected", {
          contract: OPERATION_COMPILATION_ERROR_CONTRACT,
          reason: error.code,
          message: error.message,
          sourceName: error.sourceName ?? params.sourceName ?? "<operation>",
          location: error.location ?? null,
        } satisfies OperationCompilationFailureData));
      }
      if (error instanceof OperationValidationError || error instanceof TypeError) {
        return respond(failure(id, INVALID_PARAMS, "Operation simulation rejected", {
          contract: OPERATION_COMPILATION_ERROR_CONTRACT,
          reason: "invalid-simulation",
          message: error.message,
          sourceName: params.sourceName ?? "<operation>",
          location: null,
        } satisfies OperationCompilationFailureData));
      }
      return respond(failure(id, INTERNAL_ERROR, "Internal error"));
    }
  }

  if (message.method === PROCEDURE_LIST_METHOD) {
    const params = listParams(message.params);
    if (!params) return respond(failure(id, INVALID_PARAMS, "Invalid params"));
    try {
      const procedures = await dependencies.procedures.list();
      return respond({
        jsonrpc: "2.0",
        id,
        result: {
          contract: "trust.procedure-catalog@1",
          procedures: params.summary ? procedures.map(procedureSummary) : procedures,
        },
      });
    } catch (error) {
      return respond(failure(id, INTERNAL_ERROR, "Internal error"));
    }
  }

  if (message.method === PROCEDURE_COMPILE_METHOD) {
    const params = compileParams(message.params);
    if (!params) return respond(failure(id, INVALID_PARAMS, "Invalid params"));
    try {
      const result = dependencies.procedures.compile(params);
      return respond({ jsonrpc: "2.0", id, result });
    } catch (error) {
      if (error instanceof CatalogProcedureCompilationError) {
        const data: ProcedureCompilationFailureData = {
          contract: PROCEDURE_COMPILATION_ERROR_CONTRACT,
          reason: error.code,
          message: error.message,
          sourceName: error.sourceName ?? sourceNameFrom(params),
          location: error.location ?? null,
        };
        return respond(
          failure(id, PROCEDURE_COMPILATION_ERROR, "Procedure rejected", data),
        );
      }
      return respond(failure(id, INTERNAL_ERROR, "Internal error"));
    }
  }

  if (message.method === PROCEDURE_PUBLISH_METHOD) {
    const params = compileParams(message.params);
    if (!params) return respond(failure(id, INVALID_PARAMS, "Invalid params"));
    try {
      const published = await dependencies.procedures.publish(params, "local-operator");
      return respond({
        jsonrpc: "2.0",
        id,
        result: {
          contract: "trust.published-procedure@1",
          procedure: published.procedure,
          sourceName: published.sourceName,
          publishedBy: published.publishedBy,
          publishedAt: published.publishedAt,
        },
      });
    } catch (error) {
      if (error instanceof CatalogProcedureCompilationError) {
        const data: ProcedureCompilationFailureData = {
          contract: PROCEDURE_COMPILATION_ERROR_CONTRACT,
          reason: error.code,
          message: error.message,
          sourceName: error.sourceName ?? sourceNameFrom(params),
          location: error.location ?? null,
        };
        return respond(failure(id, PROCEDURE_COMPILATION_ERROR, "Procedure definition rejected", data));
      }
      if (error instanceof ProcedureConflictError) {
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

  if (message.method === PROCEDURE_READ_METHOD) {
    const params = readParams(message.params);
    if (!params) return respond(failure(id, INVALID_PARAMS, "Invalid params"));
    try {
      const published = await dependencies.procedures.find(params.procedure, params.version);
      if (!published) return respond(failure(id, PROCEDURE_COMPILATION_ERROR, "Procedure not found"));
      return respond({
        jsonrpc: "2.0",
        id,
        result: {
          contract: "trust.published-procedure@1",
          procedure: published.procedure,
          sourceName: published.sourceName,
          publishedBy: published.publishedBy,
          publishedAt: published.publishedAt,
        },
      });
    } catch (error) {
      return respond(failure(id, INTERNAL_ERROR, "Internal error"));
    }
  }

  try {
    const result = await executePlanRuntimeRpc(message.method, message.params, dependencies);
    return respond({ jsonrpc: "2.0", id, result });
  } catch (error) {
    if (error instanceof InvalidPlanRuntimeRpcParams) {
      return respond(failure(id, INVALID_PARAMS, "Invalid params"));
    }
    if (error instanceof PlanRuntimeError) {
      const data: PlanRuntimeFailureData = {
        contract: PLAN_RUNTIME_ERROR_CONTRACT,
        reason: error.code,
        message: error.message,
      };
      return respond(failure(id, PLAN_RUNTIME_ERROR, "Plan runtime rejected", data));
    }
    if (error instanceof ReadError) {
      const data: PlanRuntimeFailureData = {
        contract: PLAN_RUNTIME_ERROR_CONTRACT,
        reason: error.code,
        message: error.message,
      };
      return respond(failure(id, PLAN_RUNTIME_ERROR, "Plan runtime rejected", data));
    }
    process.stderr.write(`plan runtime rpc ${message.method} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    return respond(failure(id, INTERNAL_ERROR, "Internal error"));
  }
};

function operationSummary(operation: ReturnType<OperationCatalog["list"]>[number]) {
  return {
    contract: operation.contract,
    operation: operation.operation,
    version: operation.version,
    title: operation.title,
    ...(operation.description === undefined ? {} : { description: operation.description }),
    ...(operation.classification === undefined ? {} : { classification: operation.classification }),
  };
}

function procedureSummary(published: Awaited<ReturnType<Procedures["list"]>>[number]) {
  const procedure = published.procedure;
  return {
    procedure: {
      contract: procedure.contract,
      procedure: procedure.procedure,
      version: procedure.version,
      title: procedure.title,
      ...(procedure.description === undefined ? {} : { description: procedure.description }),
      definitionDigest: procedure.definitionDigest,
    },
    sourceName: published.sourceName,
    publishedBy: published.publishedBy,
    publishedAt: published.publishedAt,
  };
}

const dispatch = async (
  body: unknown,
  dependencies: RpcHttpDependencies,
): Promise<RpcResult | RpcResult[] | undefined> => {
  if (!Array.isArray(body)) {
    return await processMessage(body, dependencies);
  }
  if (body.length === 0) return failure(null, INVALID_REQUEST, "Invalid Request");
  const responses = (await Promise.all(body
    .map((message) =>
      processMessage(message, dependencies),
    )))
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
    void dispatch(request.body, dependencies)
      .then((result) => {
        if (result === undefined) {
          response.status(204).end();
          return;
        }
        response.status(200).json(result);
      })
      .catch(() => response.status(500).json(failure(null, INTERNAL_ERROR, "Internal error")));
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
