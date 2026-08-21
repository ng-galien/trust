import type {
  AttemptFinalization,
  CheckAdmission,
  CheckView,
  CompiledOperation,
  CompiledProcedure,
  CredentialReference,
  DeclarationReplacement,
  EnvironmentEntry,
  HistoryFilter,
  HistorySnapshot,
  JsonObject,
  OperationEnvironments,
  OperationSimulation,
  PlanEngagement,
  PlanMode,
  PlanSummary,
  PlanView,
  PublishedProcedure,
  TrialSummary,
  TrialView,
} from "./types.js";

interface RpcResponse<T> {
  jsonrpc: "2.0";
  id: string;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

export interface RuntimeErrorLocation { line: number; column: number }

/** RPC error with the runtime's structured `data` (compilation errors carry a source location). */
export class RuntimeError extends Error {
  constructor(message: string, readonly code: number, readonly data?: unknown, readonly method?: string) {
    super(message);
    this.name = "RuntimeError";
  }

  get detail(): string {
    const data = this.data as { message?: unknown } | undefined;
    return typeof data?.message === "string" ? data.message : this.message;
  }

  /** What an operator needs to report the failure: JSON-RPC method, code, reason contract and payload. */
  get technical(): string {
    const data = this.data as { contract?: unknown; reason?: unknown } | undefined;
    const parts = [
      this.method ? `method ${this.method}` : undefined,
      `JSON-RPC ${this.code}`,
      typeof data?.reason === "string" ? `reason ${data.reason}` : undefined,
      typeof data?.contract === "string" ? data.contract : undefined,
      this.code === -32603 ? "server-side exception — see the runtime log (stderr)" : undefined,
    ].filter(Boolean);
    const payload = this.data === undefined ? "" : `\n${JSON.stringify(this.data, null, 2)}`;
    return `${parts.join(" · ")}${payload}`;
  }

  get location(): RuntimeErrorLocation | undefined {
    const data = this.data as { location?: { line?: unknown; column?: unknown } } | undefined;
    const line = data?.location?.line;
    const column = data?.location?.column;
    return typeof line === "number" ? { line, column: typeof column === "number" ? column : 1 } : undefined;
  }
}

export class TrustRuntimeClient {
  constructor(readonly baseUrl: string) {}

  languageServerUrl = (): string => {
    const base = new URL(this.baseUrl || window.location.origin, window.location.origin);
    base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
    base.pathname = `${base.pathname.replace(/\/$/, "")}/lsp`;
    base.search = "";
    base.hash = "";
    return base.toString();
  };

  async call<T>(method: string, params: JsonObject = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params }),
    });
    if (!response.ok) throw new Error(`TRUST runtime returned HTTP ${response.status}`);
    const payload = (await response.json()) as RpcResponse<T>;
    if (payload.error) throw new RuntimeError(payload.error.message, payload.error.code, payload.error.data, method);
    if (payload.result === undefined) throw new Error(`TRUST runtime returned no result for ${method}`);
    return payload.result;
  }

  health = async (): Promise<{ status: string }> => {
    const response = await fetch(`${this.baseUrl}/health`);
    if (!response.ok) throw new Error("TRUST runtime is unavailable");
    return response.json() as Promise<{ status: string }>;
  };

  operations = async () => (await this.call<{
    contract: "trust.operation-catalog@1";
    operations: CompiledOperation[];
  }>("operation.list")).operations;
  compileOperation = (source: string, sourceName = "editor.feature") =>
    this.call<CompiledOperation>("operation.compile", { source, sourceName });
  /** Writes the source into the runtime catalog directory (`<operation>.feature` by convention) and recompiles it. */
  saveOperation = (source: string, sourceName: string) =>
    this.call<{ operation: CompiledOperation; sourceName: string }>("operation.save", { source, sourceName });
  removeOperation = (operation: string, version: string) =>
    this.call<{ operation: string; version: string; removed: true }>("operation.remove", { operation, version });
  simulateOperation = (source: string, input: JsonObject, environment: JsonObject, steps: JsonObject) =>
    this.call<OperationSimulation>("operation.simulate", {
      source,
      sourceName: "editor.feature",
      input,
      environment,
      steps,
    });
  procedures = async () => (await this.call<{
    contract: "trust.procedure-catalog@1";
    procedures: PublishedProcedure[];
  }>("procedure.list")).procedures;
  compileProcedure = (source: string, sourceName = "editor.feature") =>
    this.call<CompiledProcedure>("procedure.compile", { source, sourceName });
  publishProcedure = (source: string) =>
    this.call<PublishedProcedure>("procedure.publish", {
      source,
      sourceName: "editor.feature",
    });
  plans = async () => (await this.call<{
    contract: "trust.plan-catalog@1";
    plans: PlanSummary[];
  }>("plan.list")).plans;
  plan = (plan: string) => this.call<PlanView>("plan.read", { plan });
  history = (params: { filter?: HistoryFilter; cursor?: string; limit?: number } = {}) =>
    this.call<{ snapshots: HistorySnapshot[]; nextCursor?: string }>("history.list", params as JsonObject);
  engagePlan = (params: { procedure: string; procedureVersion: string; plan: string; environment: string; rootInputs: JsonObject; mode?: PlanMode }) =>
    this.call<PlanEngagement>("plan.engage", { contract: "trust.plan-engagement-request@1", ...params });
  replaceDeclarations = (plan: string, expectedRevision: number, declarations: JsonObject) =>
    this.call<DeclarationReplacement>("plan.declarations.replace", { contract: "trust.plan-declaration-replacement-request@1", plan, expectedRevision, declarations });
  /** `reobserve` (dry-runs only): admit a satisfied Check again to replay it and watch the cascade. */
  admitCheck = (checkUri: string, attemptKey: string, options: { reobserve?: boolean } = {}) =>
    this.call<CheckAdmission>("check.attempt.admit", { contract: "trust.check-admission-request@1", attemptKey, checkUri, ...(options.reobserve ? { reobserve: true } : {}) });
  /** Same Fact batch the runner reports over OTLP: one Fact per observation of the admitted Operation. */
  postFacts = (admission: { attemptKey: string; attemptHandle: string; checkUri: string; operation: string }, values: JsonObject) => {
    const now = new Date().toISOString();
    return this.call<{ acceptedFactIds: string[]; duplicateFactIds: string[] }>("check.attempt.facts", {
      contract: "trust.fact-batch-request@1",
      attemptKey: admission.attemptKey,
      attemptHandle: admission.attemptHandle,
      checkUri: admission.checkUri,
      recordedAt: now,
      facts: [{ kind: admission.operation, observedAt: now, values }],
    });
  };
  /** Dry-runs only: erase the Plan entirely (the runtime refuses for a live Plan). */
  removePlan = (plan: string) => this.call<{ plan: string; removed: true }>("plan.remove", { plan });
  /** Dry-runs only: atomically erase the execution history and engage the same Plan again from revision 1. */
  resetPlan = (plan: string) => this.call<PlanEngagement>("plan.reset", { plan });
  /** Closes the Plan's open Session, if any (`closed: false` when none was open). */
  closePlan = (plan: string) => this.call<{ plan: string; closed: boolean }>("plan.close", { plan });
  finalizeAttempt = (attemptHandle: string) =>
    this.call<AttemptFinalization>("check.attempt.finalize", { contract: "trust.attempt-finalization-request@1", attemptHandle });
  check = (checkUri: string) => this.call<CheckView>("check.read", {
    contract: "trust.check-read-request@1",
    checkUri,
  });
  operationEnvironments = async () => (await this.call<{ operations: OperationEnvironments[] }>("operation.environments")).operations;
  environments = async (scope?: { operation?: string; version?: string; source?: string }) =>
    (await this.call<{ environments: EnvironmentEntry[] }>("environment.list", scope ?? {})).environments;
  saveEnvironment = async (environment: string, values: Record<string, string>) =>
    (await this.call<{ environment: EnvironmentEntry }>("environment.save", { environment, values })).environment;
  removeEnvironment = async (environment: string) =>
    (await this.call<{ environment: string; removed: boolean }>("environment.remove", { environment })).removed;
  /** Credential references only — the runtime never returns a value. */
  credentials = async (environment?: string) =>
    (await this.call<{ credentials: CredentialReference[] }>("credential.list", environment ? { environment } : {})).credentials;
  saveCredential = async (environment: string, name: string, value: string) =>
    (await this.call<{ credential: CredentialReference }>("credential.save", { environment, name, value })).credential;
  removeCredential = async (environment: string, name: string) =>
    (await this.call<{ removed: boolean }>("credential.remove", { environment, name })).removed;
  startTrial = async (params: { operation?: string; version?: string; source?: string; environment: string; input: JsonObject }) =>
    (await this.call<{ trial: TrialSummary }>("operation.trial.start", params)).trial;
  cancelTrial = async (trial: string) =>
    (await this.call<{ trial: TrialSummary }>("operation.trial.cancel", { trial })).trial;
  trial = async (trial: string, after = 0) => (await this.call<{ trial: TrialView }>("operation.trial.read", { trial, after })).trial;
  trials = async (operation?: string) => (await this.call<{ trials: TrialSummary[] }>("operation.trial.list", operation ? { operation } : {})).trials;
  planEventsUrl = () => `${this.baseUrl}/events/plans`;
  trialStreamUrl = (trial: string) => `${this.baseUrl}/otlp/diagnostics/trials/${encodeURIComponent(trial)}/stream`;
}
