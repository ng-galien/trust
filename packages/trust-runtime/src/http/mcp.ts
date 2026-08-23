import express, {
  type ErrorRequestHandler,
  type RequestHandler,
  type Router,
} from "express";

import {
  ReadError,
  type CheckView,
  type PlanView,
  type PlanReader,
  type SessionView,
} from "../plan/read.js";
import {
  PlanRuntimeError,
  type PlanEngagementInput,
  type PlanEngagementResult,
  type PlanDeclarationReplacementInput,
  type PlanDeclarationReplacementResult,
  type PlanRuntime,
} from "../plan/runtime.js";

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
  readonly planReader: PlanReader;
  readonly planRuntime: PlanRuntime;
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
    if (!acceptsJson(request.get("accept"))) {
      response.status(406).end();
      return;
    }
    void dispatch(
      request.body,
      request.get("mcp-protocol-version"),
      dependencies,
    ).then((result) => {
      if (result === undefined) {
        response.status(202).end();
        return;
      }
      response.status(200).json(result);
    }).catch(() => response.status(500).json(failure(null, INVALID_REQUEST, "Internal error")));
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

async function dispatch(
  message: unknown,
  protocolVersion: string | undefined,
  dependencies: McpHttpDependencies,
): Promise<JsonRpcResponse | undefined> {
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
      return success(id, { tools: tools() });
    case "tools/call":
      return callTool(id, message.params, dependencies);
    default:
      return failure(id, METHOD_NOT_FOUND, "Method not found");
  }
}

async function callTool(
  id: JsonRpcId,
  value: unknown,
  dependencies: McpHttpDependencies,
): Promise<JsonRpcResponse> {
  if (!isRecord(value) || !isToolName(value.name) || !isRecord(value.arguments)) {
    return failure(id, INVALID_PARAMS, "Unknown tool or invalid arguments");
  }
  if (value.name === "trust_plan_engage") {
    const input = exactPlanEngagement(value.arguments);
    if (input === undefined) {
      return failure(id, INVALID_PARAMS, "Plan engagement arguments are invalid");
    }
    try {
      const result = await dependencies.planRuntime.engage(input);
      return textResult(
        id,
        renderEngagement(result, await dependencies.planReader.readPlanBySlug(result.plan)),
      );
    } catch (error) {
      if (error instanceof PlanRuntimeError) {
        return toolError(id, `TRUST Plan engagement refused: ${error.message}`);
      }
      throw error;
    }
  }
  if (value.name === "trust_plan_declarations_replace") {
    const input = exactPlanDeclarationReplacement(value.arguments);
    if (input === undefined) {
      return failure(id, INVALID_PARAMS, "Plan declaration replacement arguments are invalid");
    }
    try {
      const result = await dependencies.planRuntime.replaceDeclarations(input);
      return textResult(
        id,
        renderDeclarationReplacement(
          result,
          await dependencies.planReader.readPlanBySlug(result.plan),
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
        const page = await dependencies.planReader.readProcedure({
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
        return textResult(id, renderPlan(await dependencies.planReader.readPlan(checkUri)));
      case "trust_session_read":
        return textResult(id, renderSession(await dependencies.planReader.readSession(checkUri)));
      case "trust_check_read":
        return textResult(id, renderCheck(await dependencies.planReader.readCheck(checkUri)));
    }
  } catch (error) {
    if (error instanceof ReadError) {
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

function renderEngagement(result: PlanEngagementResult, view: PlanView): string {
  return [
    "PLAN ENGAGEMENT",
    `Result: ${result.status}`,
    `Environment: ${result.environment}`,
    "",
    renderPlan(view),
  ].join("\n");
}

function renderProcedurePage(page: { readonly source: string; readonly nextCursor?: string }): string {
  const navigation = page.nextCursor === undefined
    ? [
        "Complete: yes",
        "Next: use trust_plan_read to see the current work.",
      ]
    : [
        "Complete: no",
        `Next cursor: ${page.nextCursor}`,
        "Next: call trust_procedure_read again with the same Check URI and this exact cursor.",
      ];
  return `PROCEDURE SOURCE\n${page.source}\n\nREAD STATUS\n${navigation.join("\n")}\n`;
}

function renderDeclarationReplacement(
  result: PlanDeclarationReplacementResult,
  view: PlanView,
): string {
  return [
    "PLAN DECLARATIONS REPLACED",
    `Result: ${result.status}`,
    `Revision: ${result.revision}`,
    `Current Checks: ${result.checkUris.length}`,
    ...(result.openedCheckUris.length === 0
      ? []
      : [`Opened Checks: ${result.openedCheckUris.length}`]),
    ...(result.removedCheckUris.length === 0
      ? []
      : [`Removed Checks: ${result.removedCheckUris.length}`]),
    "",
    renderPlan(view),
  ].join("\n");
}

function renderPlan(view: PlanView): string {
  const actionable = view.checks.filter((check) => check.actionable);
  const blocked = view.checks.filter((check) => check.state === "OPEN" && !check.actionable);
  const missingRoles = view.declarationRoles.filter(({ role }) => (
    view.missingDeclarations.includes(role)
  ));
  const optionalRoles = view.declarationRoles.filter(({ optional }) => optional);
  const lines: string[] = [
    "PLAN",
    `Plan: ${view.plan}`,
    `Procedure: ${view.procedure}@${view.procedureVersion}`,
    `Revision: ${view.revision}`,
    `State: ${view.workState}`,
    `Session: ${view.sessionState}`,
    `Progress: ${view.satisfiedChecks}/${view.checks.length} current Checks satisfied`,
    ...(view.intentChaining
      ? [
          "",
          "INTENT CHAINING",
          `State: ${view.intentChainState}`,
          `Current intent: ${view.currentIntent ?? "none"}`,
          ...(view.currentIntentCheckUri === null ? [] : [`Current intent Check: ${view.currentIntentCheckUri}`]),
          ...(view.intentChainState === "ACTIVE"
            ? [
                "Continuing URI template: <opaque-check-uri>?intent={intent}&nextIntent={nextIntent}",
                "Final URI template: <opaque-check-uri>?intent={intent}",
                "Use the one template shown for the selected Check. Replace {intent} with the exact Current intent. Every intent value must contain 1 to 1024 characters, be trimmed and single-line, contain no control character, and be URL-encoded.",
              ]
            : []),
        ]
      : []),
    "",
    "NEXT",
    ...planNext(view, actionable.length),
  ];

  if (actionable.length > 0) {
    lines.push(
      "",
      "ACTIONABLE CHECKS",
      ...actionable.flatMap((check) => renderActionableCheck(check, view)),
    );
  }
  if (missingRoles.length > 0) {
    lines.push(
      "",
      "MISSING DECLARATIONS",
      `Replace the complete declaration snapshot for Plan ${view.plan} at revision ${view.revision}.`,
      ...missingRoles.flatMap(renderDeclarationRole),
    );
  }
  if (optionalRoles.length > 0) {
    lines.push(
      "",
      "OPTIONAL DECLARATIONS",
      "These agent declarations may be omitted. When supplied, they keep their declared type, cardinality and parent rules.",
      ...optionalRoles.flatMap(renderDeclarationRole),
    );
  }
  const declarationEntries = Object.entries(view.declarations);
  if (declarationEntries.length > 0) {
    lines.push(
      "",
      "CURRENT DECLARATIONS",
      ...declarationEntries.map(([role, value]) => `- ${role} = ${JSON.stringify(value)}`),
    );
  }
  if (blocked.length > 0) {
    lines.push(
      "",
      "BLOCKED CHECKS",
      ...blocked.flatMap((check) => renderBlockedCheck(check, view.checks)),
    );
  }
  lines.push(
    "",
    "CURRENT CHECKLIST",
    ...view.checks.map((check) => (
      `- [${check.state}${check.actionable ? ", ACTIONABLE" : ""}] ${check.name} (${check.scenario})`
    )),
  );
  if (view.latestQualification !== null) {
    lines.push(
      "",
      "LATEST ACCEPTED ATTEMPT",
      `Check URI: ${view.latestQualification.checkUri}`,
      `Execution ID: ${view.latestQualification.executionId}`,
      `Verdict: ${view.latestQualification.verdict}`,
      `Reason: ${view.latestQualification.reasonCode} — ${view.latestQualification.reason}`,
      ...renderChecklistDelta(view.latestQualification),
    );
  }
  lines.push("", ...renderRevisionChange(view));
  return `${lines.join("\n")}\n`;
}

function renderSession(view: SessionView): string {
  return [
    "SESSION",
    `Plan: ${view.plan}`,
    `Revision: ${view.activeRevision}`,
    `State: ${view.state}`,
    `Plan state: ${view.workState}`,
    `Progress: ${view.satisfiedChecks}/${view.satisfiedChecks + view.openChecks} current Checks satisfied`,
    "",
    "NEXT",
    view.checklistComplete
      ? "The Plan is complete. No further Check is required."
      : view.state === "OPEN"
        ? "Use trust_plan_read with the same Check URI to see the next work."
        : "The Session is unavailable. Do not run a Check until it is open.",
    "",
  ].join("\n");
}

function renderCheck(view: CheckView): string {
  const lines = [
    "CHECK",
    `Check: ${view.checkUri}`,
    `Name: ${view.name}`,
    `Scenario: ${view.scenario}`,
    `Status: ${view.state}`,
    `Operation: ${view.operation}`,
    formatTarget(view),
    "Inputs:",
    ...formatInputs(view.inputs),
    "",
    "NEXT",
    view.state === "SATISFIED"
      ? "This Check is already satisfied. Use trust_plan_read to continue the Plan."
      : view.actionable
        ? "Use trust_plan_read to obtain this Check's invocation URI, then run it with the TRUST Skill."
        : "Do not run this Check yet. Resolve the blockers below, then read the Plan again.",
  ];
  if (view.blockedBy.length > 0) {
    lines.push("", "BLOCKED BY", ...view.blockedBy.map((blocker) => `- ${renderBlocker(blocker)}`));
  }
  if (view.latestVerdict !== null && view.latestReasonCode !== null && view.reason !== null) {
    lines.push(
      "",
      "LATEST ACCEPTED ATTEMPT",
      `Execution ID: ${view.history.at(-1)!.executionId}`,
      `Verdict: ${view.latestVerdict}`,
      `Reason: ${view.latestReasonCode} — ${view.reason}`,
    );
  }
  if (view.history.length > 0) {
    lines.push(
      "",
      `ACCEPTED ATTEMPT HISTORY (${view.history.length})`,
      ...view.history.flatMap((attempt, index) => [
        `${index + 1}. ${attempt.verdict} — ${attempt.reasonCode}: ${attempt.reason}`,
        `   Execution ID: ${attempt.executionId}`,
        ...renderChecklistDelta(attempt.checklistDelta).map((line) => `   ${line}`),
      ]),
    );
  }
  return `${lines.join("\n")}\n`;
}

function planNext(view: PlanView, actionableChecks: number): readonly string[] {
  if (view.checklistComplete) return ["The Plan is complete. Do not run another Check."];
  if (view.sessionState !== "OPEN") {
    return ["The Session is unavailable. Do not run a Check until it is open."];
  }
  if (view.intentChainState === "NOT_STARTED") {
    return ["Read this Plan with trust_plan_read before running a Check. That read starts its intent chain."];
  }
  const actions: string[] = [];
  if (actionableChecks > 0) {
    actions.push(
      view.intentChainState === "ACTIVE"
        ? `Run ${actionableChecks} actionable Check${actionableChecks === 1 ? "" : "s"} with the TRUST Skill. Use one invocation URI template shown below.`
        : `Run ${actionableChecks} actionable Check${actionableChecks === 1 ? "" : "s"} with the TRUST Skill. Pass only a Check URI shown below.`,
    );
  }
  if (view.missingDeclarations.length > 0) {
    actions.push(
      `Declare ${view.missingDeclarations.length} missing declaration role${view.missingDeclarations.length === 1 ? "" : "s"} with trust_plan_declarations_replace.`,
    );
  }
  if (actions.length === 1 && actionableChecks === 1) {
    return [
      view.intentChainState === "ACTIVE"
        ? "Run this Check with the TRUST Skill. Use its invocation URI template under ACTIONABLE CHECKS."
        : "Run this Check with the TRUST Skill. Pass only the exact Check URI shown under ACTIONABLE CHECKS.",
    ];
  }
  if (actions.length > 0) return ["You can act now:", ...actions.map((action) => `- ${action}`)];
  return ["No Check is actionable now. Read BLOCKED CHECKS, resolve its prerequisites, then read the Plan again."];
}

function renderActionableCheck(
  check: PlanView["checks"][number],
  view: PlanView,
): readonly string[] {
  return [
    `- ${check.name} (${check.scenario})`,
    `  Check URI: ${check.checkUri}`,
    ...(view.intentChainState === "ACTIVE"
      ? [check.completesPlan
          ? `  Final invocation URI: ${check.checkUri}?intent={intent}`
          : `  Continuing invocation URI: ${check.checkUri}?intent={intent}&nextIntent={nextIntent}`]
      : []),
    `  Operation: ${check.operation}`,
    `  ${formatTarget(check)}`,
    "  Inputs:",
    ...formatInputs(check.inputs).map((line) => `    ${line}`),
  ];
}

function renderBlockedCheck(
  check: PlanView["checks"][number],
  checks: PlanView["checks"],
): readonly string[] {
  return [
    `- ${check.name} (${check.scenario})`,
    `  Check URI: ${check.checkUri}`,
    ...check.blockedBy.map((blocker) => `  - ${renderBlocker(blocker, checks)}`),
  ];
}

function renderBlocker(blocker: string, checks: PlanView["checks"] = []): string {
  const dependency = checks.find(({ checkUri }) => checkUri === blocker);
  if (dependency !== undefined) {
    return `Waiting for ${dependency.name} to be satisfied: ${dependency.checkUri}`;
  }
  const scenario = /^scenario (.+) has no current Check$/.exec(blocker)?.[1];
  if (scenario !== undefined) {
    return `Scenario "${scenario}" has no current Check yet. Its Checks will appear when their required context exists.`;
  }
  if (blocker === "current Plan context is unavailable") {
    return "The current Plan context is unavailable. Read the Plan and complete its missing declarations first.";
  }
  if (blocker === "Plan Session is unavailable") {
    return "The Plan Session is unavailable. Do not run this Check until a Session is open.";
  }
  return blocker;
}

function renderDeclarationRole(
  role: PlanView["declarationRoles"][number],
): readonly string[] {
  const parents = role.parents.map((parent) => (
    `${parent.each ? "parent for each" : "parent"}: ${parent.role}`
  ));
  const item = `<${role.type}>`;
  const correlatedParent = role.parents.find(({ each }) => each);
  const shape = correlatedParent === undefined
    ? role.cardinality === "many" ? `[${item}, ...]` : item
    : `[{"value": ${item}, "parents": [{"role": "${correlatedParent.role}", "value": <matching ${correlatedParent.role}>}]}]`;
  const coordinatedRule = role.cardinality === "many" ? "one or more entries" : "exactly one entry";
  return [
    `- ${role.role}: ${role.cardinality} ${role.type}${role.optional ? "; optional" : ""}${parents.length === 0 ? "" : `; ${parents.join("; ")}`}`,
    `  Value shape: ${shape}${correlatedParent === undefined ? "" : ` (${coordinatedRule} for each ${correlatedParent.role})`}`,
  ];
}

function formatTarget(check: Pick<CheckView, "target">): string {
  return `Target: ${check.target.role} (${check.target.selection}) = ${JSON.stringify(check.target.value)}`;
}

function formatInputs(inputs: Readonly<Record<string, unknown>>): readonly string[] {
  const entries = Object.entries(inputs);
  return entries.length === 0
    ? ["- none"]
    : entries.map(([name, value]) => `- ${name} = ${JSON.stringify(value)}`);
}

function renderChecklistDelta(delta: {
  readonly newlySatisfied: readonly string[];
  readonly newlyOpened: readonly string[];
}): readonly string[] {
  return [
    ...(delta.newlySatisfied.length === 0
      ? []
      : [
          `Newly satisfied Checks: ${delta.newlySatisfied.length}`,
          ...delta.newlySatisfied.map((checkUri) => `- ${checkUri}`),
        ]),
    ...(delta.newlyOpened.length === 0
      ? []
      : [
          `Newly opened Checks: ${delta.newlyOpened.length}`,
          ...delta.newlyOpened.map((checkUri) => `- ${checkUri}`),
        ]),
  ];
}

function renderRevisionChange(view: PlanView): readonly string[] {
  const change = view.latestRevisionChange;
  if (change.fromRevision === null) {
    return ["REVISION", `Revision ${change.toRevision} created ${change.added.length} current Checks.`];
  }
  const details = [
    ...change.added.map((checkUri) => `- Added: ${checkUri}`),
    ...change.removed.map((checkUri) => `- Removed: ${checkUri}`),
    ...change.newlySatisfied.map((checkUri) => `- Newly satisfied: ${checkUri}`),
    ...change.newlyOpened.map((checkUri) => `- Newly opened: ${checkUri}`),
    ...change.changed.map((checkUri) => `- Changed: ${checkUri}`),
  ];
  return [
    "REVISION",
    `Latest change: ${change.fromRevision} -> ${change.toRevision}`,
    ...(details.length === 0 ? ["No current Check changed."] : details),
  ];
}

function tools(): readonly unknown[] {
  const checkUri = {
    type: "string",
    description: "Canonical semantic TRUST Check URI",
  };
  const readTools = [
    {
      name: "trust_check_read",
      title: "Read a TRUST Check",
      description: "Read one Check before running it. Returns whether it is actionable, its exact Operation inputs, blockers, and accepted attempt history.",
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
      description: "Start here after receiving any Check URI. Returns Plan progress, the next actions, actionable Checks, missing declarations, and explained blockers.",
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
      description: "Read the authoritative Gherkin procedure when the Plan summary is not enough. Read every contiguous page; the response gives the exact next cursor until Complete is yes.",
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
      description: "Read whether the Check URI resolves to an open Session. Use trust_plan_read for the actual work.",
      inputSchema: {
        type: "object",
        properties: { checkUri },
        required: ["checkUri"],
        additionalProperties: false,
      },
    },
  ];
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
