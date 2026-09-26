import type { ExternalPrincipal } from "./access.js";

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
}
export interface ExtensionContext {
  configuration: Record<string, string>;
  environment: string;
  publishChanged(): void;
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

/** Paths may target only this installed extension's API, commands and TRUST projections. */
export interface ExtensionUiTransport {
  fetch(path: string, init?: RequestInit): Promise<Response>;
  openEvents(): ExtensionEventStream;
}
