/** Hooks supplied by an integration; no TRUST storage or implementation access. */
export interface ExtensionLifecycle {
  prepare(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  read(input: unknown): Promise<unknown>;
  command?(input: unknown): Promise<unknown>;
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
