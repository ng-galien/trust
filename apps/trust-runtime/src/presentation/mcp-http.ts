import express, {
  type ErrorRequestHandler,
  type RequestHandler,
  type Router,
} from "express";

import {
  AgentReadError,
  type AgentCheckView,
  type AgentPlanView,
  type AgentReadService,
  type AgentSessionView,
} from "../application/agent-read-service.js";
import {
  PlanRuntimeError,
  type PlanEngagementInput,
  type PlanEngagementResult,
  type PlanDeclarationReplacementInput,
  type PlanDeclarationReplacementResult,
  type PlanRuntimeService,
} from "../application/plan-runtime-service.js";
import {
  RegistryAuthorityError,
  type RegistryAuthority,
  type RegistryPrincipal,
} from "../ports/registry-authority.js";

export const MCP_JSON_LIMIT_BYTES = 1_048_576;

const PARSE_ERROR = -32_700;
const INVALID_REQUEST = -32_600;
const METHOD_NOT_FOUND = -32_601;
const INVALID_PARAMS = -32_602;

const READ_TOOL_NAMES = [
  "trust_check_read",
  "trust_plan_read",
  "trust_procedure_read",
  "trust_session_read",
] as const;
const TOOL_NAMES = [
  ...READ_TOOL_NAMES,
  "trust_plan_engage",
  "trust_plan_declarations_replace",
] as const;

type ToolName = (typeof TOOL_NAMES)[number];
type JsonRpcId = string | number;

interface McpHttpDependencies {
  readonly agentReadService: AgentReadService;
  readonly planRuntimeService: PlanRuntimeService;
  readonly registryAuthority: RegistryAuthority;
}

interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId | null;
  readonly result?: unknown;
  readonly error?: {
    readonly code: number;
    readonly message: string;
  };
}

export function createMcpHttpHandler(dependencies: McpHttpDependencies): Router {
  const router = express.Router();
  const handle: RequestHandler = (request, response) => {
    let principal: RegistryPrincipal;
    try {
      const authorizationHeader = request.get("authorization");
      principal = dependencies.registryAuthority.authorize({
        ...(authorizationHeader === undefined ? {} : { authorizationHeader }),
        anyRoleOf: ["observer", "operator"],
      });
    } catch (error) {
      if (error instanceof RegistryAuthorityError) {
        response.status(401).json(failure(null, INVALID_REQUEST, "MCP access denied"));
        return;
      }
      throw error;
    }

    if (!acceptsJson(request.get("accept"))) {
      response.status(406).end();
      return;
    }
    const result = dispatch(
      request.body,
      request.get("mcp-protocol-version"),
      dependencies,
      principal.roles.includes("operator"),
    );
    if (result === undefined) {
      response.status(202).end();
      return;
    }
    response.status(200).json(result);
  };

  router.get("/", (_request, response) => {
    response.set("allow", "POST");
    response.status(405).end();
  });
  router.post(
    "/",
    express.json({
      limit: MCP_JSON_LIMIT_BYTES,
      strict: true,
      type: ["application/json", "application/*+json"],
    }),
    handle,
  );
  router.use(bodyParserFailure);
  return router;
}

function dispatch(
  message: unknown,
  protocolVersion: string | undefined,
  dependencies: McpHttpDependencies,
  canEngagePlan: boolean,
): JsonRpcResponse | undefined {
  if (!isRecord(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return failure(requestId(message), INVALID_REQUEST, "Invalid Request");
  }
  if ("id" in message && typeof message.id !== "string" && typeof message.id !== "number") {
    return failure(null, INVALID_REQUEST, "Invalid Request");
  }
  const id = requestId(message);
  const notification = !("id" in message);
  if (message.method !== "initialize" && !validProtocolVersion(protocolVersion)) {
    return notification
      ? undefined
      : failure(id, INVALID_REQUEST, "MCP-Protocol-Version is required");
  }
  if (notification) return undefined;
  if (id === null) return failure(null, INVALID_REQUEST, "Invalid Request");

  switch (message.method) {
    case "initialize":
      {
        const requestedProtocolVersion = initializeProtocolVersion(message.params);
        if (requestedProtocolVersion === undefined) {
          return failure(id, INVALID_PARAMS, "Invalid initialize parameters");
        }
        return success(id, {
          protocolVersion: requestedProtocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "trust-runtime", version: "0.1.0" },
        });
      }
    case "ping":
      return success(id, {});
    case "tools/list":
      if (!validToolsListParams(message.params)) {
        return failure(id, INVALID_PARAMS, "Invalid tools/list parameters");
      }
      return success(id, { tools: tools(canEngagePlan) });
    case "tools/call":
      return callTool(id, message.params, dependencies, canEngagePlan);
    default:
      return failure(id, METHOD_NOT_FOUND, "Method not found");
  }
}

function callTool(
  id: JsonRpcId,
  value: unknown,
  dependencies: McpHttpDependencies,
  canEngagePlan: boolean,
): JsonRpcResponse {
  if (!isRecord(value) || !isToolName(value.name) || !isRecord(value.arguments)) {
    return failure(id, INVALID_PARAMS, "Unknown tool or invalid arguments");
  }
  if (value.name === "trust_plan_engage") {
    if (!canEngagePlan) {
      return toolError(id, "TRUST Plan engagement requires operator authority");
    }
    const input = exactPlanEngagement(value.arguments);
    if (input === undefined) {
      return failure(id, INVALID_PARAMS, "Plan engagement arguments are invalid");
    }
    try {
      const result = dependencies.planRuntimeService.engage(input);
      return textResult(
        id,
        renderEngagement(result, dependencies.agentReadService.readPlanBySlug(result.plan)),
      );
    } catch (error) {
      if (error instanceof PlanRuntimeError) {
        return toolError(id, `TRUST Plan engagement refused: ${error.message}`);
      }
      throw error;
    }
  }
  if (value.name === "trust_plan_declarations_replace") {
    if (!canEngagePlan) {
      return toolError(id, "TRUST Plan declaration replacement requires operator authority");
    }
    const input = exactPlanDeclarationReplacement(value.arguments);
    if (input === undefined) {
      return failure(id, INVALID_PARAMS, "Plan declaration replacement arguments are invalid");
    }
    try {
      const result = dependencies.planRuntimeService.replaceDeclarations(input);
      return textResult(
        id,
        renderDeclarationReplacement(
          result,
          dependencies.agentReadService.readPlanBySlug(result.plan),
        ),
      );
    } catch (error) {
      if (error instanceof PlanRuntimeError) {
        return toolError(id, `TRUST Plan declaration replacement refused: ${error.message}`);
      }
      throw error;
    }
  }
  const checkUri = exactCheckUri(value.arguments, value.name === "trust_procedure_read");
  if (checkUri === undefined) {
    return failure(id, INVALID_PARAMS, "Tool arguments are invalid");
  }
  try {
    switch (value.name) {
      case "trust_procedure_read": {
        const cursor = value.arguments.cursor;
        const limit = value.arguments.limit;
        if (
          (cursor !== undefined && (typeof cursor !== "string" || cursor.length === 0))
          || (limit !== undefined && !Number.isSafeInteger(limit))
        ) {
          return failure(id, INVALID_PARAMS, "Procedure page arguments are invalid");
        }
        const page = dependencies.agentReadService.readProcedure({
          checkUri,
          ...(typeof cursor === "string" ? { cursor } : {}),
          ...(typeof limit === "number" ? { limit } : {}),
        });
        return success(id, {
          content: [{ type: "text", text: renderProcedurePage(page) }],
          ...(page.nextCursor === undefined ? {} : { _meta: { nextCursor: page.nextCursor } }),
        });
      }
      case "trust_plan_read":
        return textResult(id, renderPlan(dependencies.agentReadService.readPlan(checkUri)));
      case "trust_session_read":
        return textResult(id, renderSession(dependencies.agentReadService.readSession(checkUri)));
      case "trust_check_read":
        return textResult(id, renderCheck(dependencies.agentReadService.readCheck(checkUri)));
    }
  } catch (error) {
    if (error instanceof AgentReadError) {
      const recovery = error.code === "invalid-procedure-page"
        ? " Start procedure reading again without a cursor; then use only the exact next cursor returned in the text response for this Check."
        : "";
      return success(id, {
        content: [{ type: "text", text: `TRUST read failed: ${error.message}.${recovery}` }],
        isError: true,
      });
    }
    throw error;
  }
}

function renderEngagement(result: PlanEngagementResult, view: AgentPlanView): string {
  return `${[
    "Operation: Plan engagement",
    `Plan: ${result.plan}`,
    `Status: ${result.status}`,
    `Procedure: ${result.procedure}@${result.procedureVersion}`,
    `Environment: ${result.environment}`,
    `Revision: ${result.revision}`,
    `Initial Checks: ${result.checkUris.length}`,
    ...result.checkUris.map((checkUri) => `- ${checkUri}`),
    "",
  ].join("\n")}\n--- Current Plan ---\n${renderPlan(view)}`;
}

function renderProcedurePage(page: { readonly source: string; readonly nextCursor?: string }): string {
  const navigation = page.nextCursor === undefined
    ? [
        "More pages: no",
        "Procedure read complete: yes",
      ]
    : [
        "More pages: yes",
        `Next cursor: ${page.nextCursor}`,
        "Call trust_procedure_read again with the same checkUri and this exact cursor.",
      ];
  return `${page.source}\n\n--- TRUST procedure pagination ---\n${navigation.join("\n")}`;
}

function renderDeclarationReplacement(
  result: PlanDeclarationReplacementResult,
  view: AgentPlanView,
): string {
  return `${[
    "Operation: Plan declaration replacement",
    `Plan: ${result.plan}`,
    `Status: ${result.status}`,
    `Revision: ${result.revision}`,
    `Declarations: ${JSON.stringify(result.declarations)}`,
    `Current Checks: ${result.checkUris.length}`,
    `Opened Checks: ${result.openedCheckUris.length}`,
    ...result.openedCheckUris.map((checkUri) => `- ${checkUri}`),
    `Removed Checks: ${result.removedCheckUris.length}`,
    ...result.removedCheckUris.map((checkUri) => `- ${checkUri}`),
    "",
  ].join("\n")}\n--- Current Plan ---\n${renderPlan(view)}`;
}

function renderPlan(view: AgentPlanView): string {
  const lines = [
    `Plan: ${view.plan}`,
    `Procedure: ${view.procedure}@${view.procedureVersion}`,
    `Status: ${view.state}`,
    `Session: ${view.sessionState}`,
    "Session meaning: delegation window for the current Plan",
    `Work state: ${view.workState}`,
    `Revision: ${view.revision}`,
    `Declaration roles: ${JSON.stringify(view.declarationRoles)}`,
    `Declarations: ${JSON.stringify(view.declarations)}`,
    `Missing declarations: ${JSON.stringify(view.missingDeclarations)}`,
    `Checklist complete: ${view.checklistComplete ? "yes" : "no"}`,
    `Satisfied Checks: ${view.satisfiedChecks}`,
    `Open Checks: ${view.openChecks.length}`,
    ...view.openChecks.map((checkUri) => `- ${checkUri}`),
    `Actionable Checks: ${view.actionableChecks.length}`,
    ...view.actionableChecks.map((checkUri) => `  - ${checkUri}`),
    `Blocked Checks: ${view.blockedChecks.length}`,
    ...view.blockedChecks.map((checkUri) => `  - ${checkUri}`),
    "Current checklist:",
    ...view.checks.flatMap((check) => [
      `Check: ${check.checkUri}`,
      `  Name: ${check.name}`,
      `  Scenario: ${check.scenario}`,
      `  Target: ${check.target === null ? "none" : JSON.stringify(check.target)}`,
      `  Inputs: ${JSON.stringify(check.inputs)}`,
      `  Capability: ${check.capability}`,
      `  Status: ${check.state}`,
      `  Actionable: ${check.actionable ? "yes" : "no"}`,
      `  Blocked by: ${check.blockedBy.length === 0 ? "none" : JSON.stringify(check.blockedBy)}`,
      `  Active qualification: ${check.state === "SATISFIED" ? "VALIDATED" : "none"}`,
      `  Latest accepted attempt verdict: ${check.latestVerdict ?? "none"}`,
      `  Latest accepted attempt reason code: ${check.latestReasonCode ?? "none"}`,
      `  Latest accepted attempt reason: ${check.reason ?? "none"}`,
    ]),
    `Latest revision change: ${view.latestRevisionChange.fromRevision ?? "none"} -> ${view.latestRevisionChange.toRevision}`,
    `Added Checks: ${view.latestRevisionChange.added.length}`,
    ...view.latestRevisionChange.added.map((checkUri) => `  - ${checkUri}`),
    `Removed Checks: ${view.latestRevisionChange.removed.length}`,
    ...view.latestRevisionChange.removed.map((checkUri) => `  - ${checkUri}`),
    `Newly satisfied Checks: ${view.latestRevisionChange.newlySatisfied.length}`,
    ...view.latestRevisionChange.newlySatisfied.map((checkUri) => `  - ${checkUri}`),
    `Newly opened Checks: ${view.latestRevisionChange.newlyOpened.length}`,
    ...view.latestRevisionChange.newlyOpened.map((checkUri) => `  - ${checkUri}`),
    `Changed Checks: ${view.latestRevisionChange.changed.length}`,
    ...view.latestRevisionChange.changed.map((checkUri) => `  - ${checkUri}`),
    `Unchanged Checks: ${view.latestRevisionChange.unchanged.length}`,
    ...view.latestRevisionChange.unchanged.map((checkUri) => `  - ${checkUri}`),
  ];
  lines.push(
    `Latest current-Check attempt verdict: ${view.latestQualification?.verdict ?? "none"}`,
    `Latest current-Check attempt Check: ${view.latestQualification?.checkUri ?? "none"}`,
    `Latest current-Check attempt reason code: ${view.latestQualification?.reasonCode ?? "none"}`,
    `Latest current-Check attempt reason: ${view.latestQualification?.reason ?? "none"}`,
    `Latest attempt newly satisfied Checks: ${view.latestQualification?.newlySatisfied.length ?? 0}`,
    ...(view.latestQualification?.newlySatisfied ?? []).map((checkUri) => `- ${checkUri}`),
    `Latest attempt newly opened Checks: ${view.latestQualification?.newlyOpened.length ?? 0}`,
    ...(view.latestQualification?.newlyOpened ?? []).map((checkUri) => `- ${checkUri}`),
    `Latest attempt unchanged Checks: ${view.latestQualification?.unchanged.length ?? 0}`,
    ...(view.latestQualification?.unchanged ?? []).map((checkUri) => `- ${checkUri}`),
  );
  return `${lines.join("\n")}\n`;
}

function renderSession(view: AgentSessionView): string {
  return [
    `Plan: ${view.plan}`,
    `Session: ${view.state}`,
    "Session meaning: delegation window for the current Plan",
    `Active revision: ${view.activeRevision}`,
    `Work state: ${view.workState}`,
    `Checklist complete: ${view.checklistComplete ? "yes" : "no"}`,
    `Satisfied Checks: ${view.satisfiedChecks}`,
    `Open Checks: ${view.openChecks}`,
    "Resolution: implicit from the Check URI",
    "",
  ].join("\n");
}

function renderCheck(view: AgentCheckView): string {
  return [
    `Check: ${view.checkUri}`,
    `Name: ${view.name}`,
    `Scenario: ${view.scenario}`,
    `Target: ${view.target === null ? "none" : JSON.stringify(view.target)}`,
    `Inputs: ${JSON.stringify(view.inputs)}`,
    `Status: ${view.state}`,
    `Actionable: ${view.actionable ? "yes" : "no"}`,
    `Blocked by: ${view.blockedBy.length === 0 ? "none" : JSON.stringify(view.blockedBy)}`,
    `Capability: ${view.capability}`,
    `Active qualification: ${view.state === "SATISFIED" ? "VALIDATED" : "none"}`,
    `Latest accepted attempt verdict: ${view.latestVerdict ?? "none"}`,
    `Latest accepted attempt reason code: ${view.latestReasonCode ?? "none"}`,
    `Latest accepted attempt reason: ${view.reason ?? "none"}`,
    `Accepted attempt history: ${view.history.length}`,
    ...view.history.flatMap((attempt, index) => [
      `Attempt ${index + 1}:`,
      `  Verdict: ${attempt.verdict}`,
      `  Reason code: ${attempt.reasonCode}`,
      `  Reason: ${attempt.reason}`,
      `  Newly satisfied Checks: ${attempt.checklistDelta.newlySatisfied.length}`,
      ...attempt.checklistDelta.newlySatisfied.map((checkUri) => `    - ${checkUri}`),
      `  Newly opened Checks: ${attempt.checklistDelta.newlyOpened.length}`,
      ...attempt.checklistDelta.newlyOpened.map((checkUri) => `    - ${checkUri}`),
      `  Unchanged Checks: ${attempt.checklistDelta.unchanged.length}`,
      ...attempt.checklistDelta.unchanged.map((checkUri) => `    - ${checkUri}`),
    ]),
    "",
  ].join("\n");
}

function tools(canEngagePlan: boolean): readonly unknown[] {
  const checkUri = {
    type: "string",
    description: "Canonical semantic TRUST Check URI",
  };
  const readTools = [
    {
      name: "trust_check_read",
      title: "Read a TRUST Check",
      description: "Read a Check status, blockers, required capability, latest verdict, and accepted attempt history.",
      inputSchema: {
        type: "object",
        properties: { checkUri },
        required: ["checkUri"],
        additionalProperties: false,
      },
    },
    {
      name: "trust_plan_read",
      title: "Read a TRUST Plan",
      description: "Read the active checklist and latest qualified Plan change.",
      inputSchema: {
        type: "object",
        properties: { checkUri },
        required: ["checkUri"],
        additionalProperties: false,
      },
    },
    {
      name: "trust_procedure_read",
      title: "Read a TRUST procedure",
      description: "Read the complete Gherkin source through contiguous pages. The text response states whether another page exists and gives the exact next cursor when required.",
      inputSchema: {
        type: "object",
        properties: {
          checkUri,
          cursor: { type: "string", description: "Opaque cursor for the next page" },
          limit: { type: "integer", description: "Maximum page size" },
        },
        required: ["checkUri"],
        additionalProperties: false,
      },
    },
    {
      name: "trust_session_read",
      title: "Read a TRUST Session",
      description: "Read the Session resolved implicitly from the Check.",
      inputSchema: {
        type: "object",
        properties: { checkUri },
        required: ["checkUri"],
        additionalProperties: false,
      },
    },
  ];
  if (!canEngagePlan) return readTools;
  return [
    ...readTools,
    {
      name: "trust_plan_engage",
      title: "Engage a TRUST Plan",
      description: "Create or read a Plan using only its compiled root business inputs.",
      inputSchema: {
        type: "object",
        properties: {
          procedure: { type: "string", description: "Canonical procedure slug" },
          procedureVersion: { type: "string", description: "Exact procedure version" },
          plan: { type: "string", description: "Business Plan identifier" },
          environment: { type: "string", description: "TRUST environment" },
          rootInputs: {
            type: "object",
            description: "Exact root business inputs compiled by the procedure",
          },
        },
        required: ["procedure", "procedureVersion", "plan", "environment", "rootInputs"],
        additionalProperties: false,
      },
    },
    {
      name: "trust_plan_declarations_replace",
      title: "Replace TRUST Plan declarations",
      description:
        "Replace the complete current snapshot of agent declarations authorized by the Feature. Read the Plan first to discover exact roles, types, cardinalities and parent coordinates.",
      inputSchema: {
        type: "object",
        properties: {
          plan: { type: "string", description: "Business Plan identifier" },
          expectedRevision: {
            type: "integer",
            minimum: 1,
            description: "Current Plan revision used for optimistic concurrency",
          },
          declarations: {
            type: "object",
            description: "Complete declaration snapshot using only Feature-authorized role names",
          },
        },
        required: ["plan", "expectedRevision", "declarations"],
        additionalProperties: false,
      },
    },
  ];
}

function exactPlanDeclarationReplacement(
  value: Record<string, unknown>,
): PlanDeclarationReplacementInput | undefined {
  const keys = ["plan", "expectedRevision", "declarations"];
  const expected = new Set(keys);
  if (
    Object.keys(value).length !== keys.length
    || Object.keys(value).some((key) => !expected.has(key))
    || keys.some((key) => !Object.hasOwn(value, key))
    || !boundedString(value.plan)
    || !Number.isSafeInteger(value.expectedRevision)
    || Number(value.expectedRevision) < 1
    || !isRecord(value.declarations)
  ) {
    return undefined;
  }
  return {
    contract: "trust.plan-declaration-replacement-request@1",
    plan: value.plan,
    expectedRevision: value.expectedRevision as number,
    declarations: value.declarations,
  };
}

function exactPlanEngagement(value: Record<string, unknown>): PlanEngagementInput | undefined {
  const keys = ["procedure", "procedureVersion", "plan", "environment", "rootInputs"];
  const expected = new Set(keys);
  if (
    Object.keys(value).length !== keys.length
    || Object.keys(value).some((key) => !expected.has(key))
    || keys.some((key) => !Object.hasOwn(value, key))
    || !boundedString(value.procedure)
    || !boundedString(value.procedureVersion)
    || !boundedString(value.plan)
    || !boundedString(value.environment)
    || !isRecord(value.rootInputs)
  ) {
    return undefined;
  }
  return {
    contract: "trust.plan-engagement-request@1",
    procedure: value.procedure,
    procedureVersion: value.procedureVersion,
    plan: value.plan,
    environment: value.environment,
    rootInputs: value.rootInputs,
  };
}

function exactCheckUri(
  value: Record<string, unknown>,
  procedureTool: boolean,
): string | undefined {
  const allowed = procedureTool
    ? new Set(["checkUri", "cursor", "limit"])
    : new Set(["checkUri"]);
  if (
    Object.keys(value).some((key) => !allowed.has(key))
    || typeof value.checkUri !== "string"
    || value.checkUri.length === 0
    || value.checkUri.length > 2_048
  ) {
    return undefined;
  }
  return value.checkUri;
}

function initializeProtocolVersion(value: unknown): string | undefined {
  if (
    !isRecord(value)
    || !validProtocolVersion(value.protocolVersion)
    || !isRecord(value.capabilities)
    || !isRecord(value.clientInfo)
    || typeof value.clientInfo.name !== "string"
    || typeof value.clientInfo.version !== "string"
  ) {
    return undefined;
  }
  return value.protocolVersion;
}

function validProtocolVersion(value: unknown): value is string {
  return boundedString(value, 64);
}

function validToolsListParams(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  const allowed = new Set(["_meta"]);
  return Object.keys(value).every((key) => allowed.has(key))
    && (value._meta === undefined || isRecord(value._meta));
}

function acceptsJson(value: string | undefined): boolean {
  if (value === undefined) return true;
  return value.split(",").some((entry) => {
    const mediaType = entry.split(";", 1)[0]?.trim().toLowerCase();
    return mediaType === "application/json" || mediaType === "application/*" || mediaType === "*/*";
  });
}

function isToolName(value: unknown): value is ToolName {
  return typeof value === "string" && (TOOL_NAMES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maximum = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function requestId(value: unknown): JsonRpcId | null {
  if (!isRecord(value) || !("id" in value)) return null;
  return typeof value.id === "string" || typeof value.id === "number" ? value.id : null;
}

function textResult(id: JsonRpcId, text: string): JsonRpcResponse {
  return success(id, { content: [{ type: "text", text }] });
}

function toolError(id: JsonRpcId, text: string): JsonRpcResponse {
  return success(id, { content: [{ type: "text", text }], isError: true });
}

function success(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function failure(id: JsonRpcId | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

const bodyParserFailure: ErrorRequestHandler = (error, _request, response, next) => {
  if (!isRecord(error)) {
    next(error);
    return;
  }
  if (error.type === "entity.too.large") {
    response.status(413).json(failure(null, INVALID_REQUEST, "Invalid Request"));
    return;
  }
  if (error.type === "entity.parse.failed" || error instanceof SyntaxError) {
    response.status(400).json(failure(null, PARSE_ERROR, "Parse error"));
    return;
  }
  response.status(500).json(failure(null, INVALID_REQUEST, "Internal error"));
};
