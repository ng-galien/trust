import type { CompiledOperation } from "@trust/operation";
import type { CompiledProcedure } from "@trust/procedure";
import type { ExternalPrincipal } from "./access.js";
import type {
  DelegationEpisodeView,
  PlanDeclarationReplacementInput,
  PlanDeclarationReplacementResult,
  PlanSummaryView,
  PlanView,
} from "./index.js";

/** Request-local identity projected by the trusted host; no bearer or user-supplied authority. */
export type ExtensionInvocationContext =
  | { readonly mode: "local" }
  | {
      readonly mode: "authenticated";
      readonly principal: ExternalPrincipal;
      readonly extensionId: string;
      readonly expiresAt: number;
    };

/** Hooks supplied by an integration; no TRUST storage or implementation access. */
export interface ExtensionLifecycle {
  prepare(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  read(input: unknown, context: ExtensionInvocationContext): Promise<unknown>;
  command?(input: unknown, context: ExtensionInvocationContext): Promise<unknown>;
  /** Delete this installation's own stored data; called while stopped, only on an explicit uninstall request. */
  deleteData?(): Promise<void>;
}
export interface ExtensionContext {
  /** Effective installation settings: defaults applied, credential references resolved to their values. */
  configuration: Readonly<Record<string, import("./settings.js").ExtensionSettingValue>>;
  environment: string;
  publishChanged(): void;
  /** TRUST surfaces granted to this installation, confined to its environment. */
  trust: ExtensionTrust;
}

/**
 * Server-side TRUST access. Each call names the `read` or `command` invocation still in progress: TRUST applies
 * that caller's rights and the installation's grants, as for the extension page. Outside an invocation every call
 * is refused. Executing an Operation stays the Runner's role.
 */
export interface ExtensionTrust {
  /** Requires `plans.read`. */
  listPlans(invocation: ExtensionInvocationContext): Promise<readonly PlanSummaryView[]>;
  /** Requires `plans.read`. */
  readPlan(plan: string, invocation: ExtensionInvocationContext): Promise<PlanView>;
  /** Requires `plans.read`; the Plan and every child Plan of the episode belong to the installation environment. */
  readEpisode(plan: string, invocation: ExtensionInvocationContext): Promise<DelegationEpisodeView>;
  /** Requires `plans.declare`. */
  replaceDeclarations(
    input: PlanDeclarationReplacementInput,
    invocation: ExtensionInvocationContext,
  ): Promise<PlanDeclarationReplacementResult>;
  /** Requires `catalog.read`; one exact published version. */
  readProcedure(procedure: string, version: string, invocation: ExtensionInvocationContext): Promise<CompiledProcedure>;
  /** Requires `catalog.read`; one exact published version. */
  readOperation(operation: string, version: string, invocation: ExtensionInvocationContext): Promise<CompiledOperation>;
}

export const EXTENSION_TRUST_FAILURES = [
  "capability-denied",
  "access-denied",
  "invocation-ended",
  "invalid-request",
  "not-found",
  "refused",
  "unavailable",
] as const;
export type ExtensionTrustFailure = (typeof EXTENSION_TRUST_FAILURES)[number];

/** Closed refusal of a server-side TRUST call; `message` is the public reason of a `refused` Plan change. */
export class ExtensionTrustError extends Error {
  constructor(
    readonly failure: ExtensionTrustFailure,
    message: string = failure,
  ) {
    super(message);
    this.name = "ExtensionTrustError";
  }
}
export type ExtensionFactory = (context: ExtensionContext) => ExtensionLifecycle | Promise<ExtensionLifecycle>;
export type ExtensionState = "STOPPED" | "PREPARING" | "STARTING" | "RUNNING" | "STOPPING" | "FAILED";
export interface ExtensionDescriptor {
  id: string;
  title: string;
  version: string;
  state: ExtensionState;
  error?: { code: string; message: string };
  apiBase: string;
  ui?: { name: string; entry: string; module: string };
}
export interface ExtensionPageProps {
  /** Host-owned transport restricted to this extension; never exposes credentials. */
  transport: ExtensionUiTransport;
  apiBase: string;
  trustBase: string;
  eventsUrl: string;
  language: string;
  navigation?: {
    planHref(plan: string, mode?: string): string;
    procedureHref(procedure: string, version?: string): string;
    navigate(href: string): void;
    search: string;
    replaceSearch(search: string): void;
  };
}

/** Browser event projection supplied by the host, with credentials outside the URL. */
export interface ExtensionEventStream extends EventTarget {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  close(): void;
}

/** Paths target this installation's API, commands and granted TRUST surfaces, including Plan declarations. */
export interface ExtensionUiTransport {
  fetch(path: string, init?: RequestInit): Promise<Response>;
  openEvents(): ExtensionEventStream;
}
