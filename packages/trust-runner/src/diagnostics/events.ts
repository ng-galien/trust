import type { JsonObject, JsonValue } from "../lib/json.js";

/* Diagnostic events emitted while an Operation runs. They exist for humans validating an
   Operation (trial runs); they are never Facts and never reach a Plan. */

export type StepKind = "shell" | "http" | "file-read";

export interface OperationStartEvent {
  readonly type: "operation.start";
  readonly at: string;
  readonly operation: string;
  readonly version: string;
  readonly stepCount: number;
}

export interface StepStartEvent {
  readonly type: "step.start";
  readonly at: string;
  readonly step: string;
  readonly index: number;
  readonly kind: StepKind;
  /** What is about to run: command line, request line or file path (secrets never appear here by grammar). */
  readonly summary: string;
  readonly detail: JsonObject;
}

export type LogStream = "stdout" | "stderr" | "http.request" | "http.response" | "file" | "runner";

export interface StepLogEvent {
  readonly type: "step.log";
  readonly at: string;
  readonly step: string;
  readonly stream: LogStream;
  readonly text: string;
}

export interface StepEndEvent {
  readonly type: "step.end";
  readonly at: string;
  readonly step: string;
  readonly ok: boolean;
  readonly durationMs: number;
  /** Compact outcome: exit code, HTTP status, bytes read… */
  readonly outcome: JsonObject;
  readonly error?: string;
}

export interface OperationEndEvent {
  readonly type: "operation.end";
  readonly at: string;
  readonly ok: boolean;
  readonly durationMs: number;
  readonly produced?: JsonObject;
  readonly steps?: JsonObject;
  readonly error?: string;
}

export interface RunnerLogEvent {
  readonly type: "runner.log";
  readonly at: string;
  readonly level: "info" | "warn" | "error";
  readonly text: string;
}

export type DiagnosticEvent =
  | OperationStartEvent
  | StepStartEvent
  | StepLogEvent
  | StepEndEvent
  | OperationEndEvent
  | RunnerLogEvent;

export interface DiagnosticsSink {
  emit(event: DiagnosticEvent): void;
  flush(): Promise<void>;
}

export const nullSink: DiagnosticsSink = {
  emit() {},
  async flush() {},
};

/** Per-step reporter handed to the shell / HTTP / file runners. */
export interface StepReporter {
  log(stream: LogStream, text: string): void;
}

export const nullReporter: StepReporter = { log() {} };

export const now = (): string => new Date().toISOString();

/** Keeps diagnostics bounded: long outputs are truncated with an explicit marker. */
export function clip(text: string, max = 64 * 1024): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… [truncated ${text.length - max} characters]`;
}

export function summarizeValue(value: JsonValue | undefined, max = 2_048): string {
  if (value === undefined) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return clip(text, max);
}
