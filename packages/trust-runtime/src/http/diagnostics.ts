import express, { type Router } from "express";

import { RegistryAuthorityError, type RegistryAuthority } from "../skill/authority.js";
import type { TrialRegistry } from "../trial/registry.js";

/* Diagnostic OTLP receiver — separate from the production /v1/traces ingest.
   Accepts OTLP/JSON logs and spans emitted by a trial runner, keyed by the `trust.trial.id`
   resource attribute, keeps them in memory and fans them out over SSE. Nothing is stored as a Fact. */

export const DIAGNOSTICS_JSON_LIMIT_BYTES = 4 * 1_048_576;

export interface DiagnosticsHttpDependencies {
  readonly trialRegistry: TrialRegistry;
  readonly registryAuthority: RegistryAuthority;
}

export function createDiagnosticsHttpHandler({ trialRegistry, registryAuthority }: DiagnosticsHttpDependencies): Router {
  const router = express.Router();
  router.use(express.json({ limit: DIAGNOSTICS_JSON_LIMIT_BYTES, type: () => true }));

  router.post("/v1/logs", (request, response) => {
    let accepted = 0;
    for (const { trialId, event } of logRecords(request.body)) {
      if (trialRegistry.append(trialId, event)) accepted += 1;
    }
    response.status(200).json(accepted === 0 ? { partialSuccess: { rejectedLogRecords: countLogRecords(request.body), errorMessage: "unknown trial" } } : {});
  });

  router.post("/v1/traces", (request, response) => {
    let accepted = 0;
    for (const { trialId, event } of spans(request.body)) {
      if (trialRegistry.append(trialId, event)) accepted += 1;
    }
    response.status(200).json(accepted === 0 ? { partialSuccess: { rejectedSpans: 0 } } : {});
  });

  // Live event stream for one trial. EventSource cannot send headers: the operator token travels as ?token=.
  router.get("/trials/:id/stream", (request, response) => {
    const token = typeof request.query.token === "string" ? request.query.token : undefined;
    const header = token ? `Bearer ${token}` : request.get("authorization");
    try {
      registryAuthority.authorize({
        ...(header === undefined ? {} : { authorizationHeader: header }),
        anyRoleOf: ["observer", "operator", "publisher"],
      });
    } catch (error) {
      if (error instanceof RegistryAuthorityError) {
        response.status(401).json({ error: error.reason, message: error.message });
        return;
      }
      throw error;
    }
    const trial = trialRegistry.get(String(request.params.id));
    if (!trial) {
      response.status(404).json({ error: "unknown-trial" });
      return;
    }
    const after = Number(request.get("last-event-id") ?? request.query.after ?? 0);
    response.status(200);
    response.setHeader("content-type", "text/event-stream");
    response.setHeader("cache-control", "no-cache, no-transform");
    response.setHeader("connection", "keep-alive");
    response.setHeader("x-accel-buffering", "no");
    response.flushHeaders();

    const send = (event: { sequence: number; type: string }) => {
      response.write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    for (const event of trial.events) if (event.sequence > after) send(event);
    if (trial.status !== "starting" && trial.status !== "running") {
      response.write("event: end\ndata: {}\n\n");
      response.end();
      return;
    }
    const unsubscribe = trialRegistry.subscribe(trial.id, (event) => {
      send(event);
      if (event.type === "trial.completed") {
        response.write("event: end\ndata: {}\n\n");
        response.end();
      }
    });
    const heartbeat = setInterval(() => response.write(": keep-alive\n\n"), 15_000);
    request.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  return router;
}

/* --------------------------------------------------------------- OTLP/JSON */

interface OtlpAttribute { key?: unknown; value?: unknown }

function readAttributes(list: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!Array.isArray(list)) return out;
  for (const entry of list as OtlpAttribute[]) {
    if (typeof entry?.key === "string") out[entry.key] = anyValue(entry.value);
  }
  return out;
}

function anyValue(value: unknown): unknown {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if ("stringValue" in record) return record.stringValue;
  if ("boolValue" in record) return record.boolValue;
  if ("intValue" in record) return Number(record.intValue);
  if ("doubleValue" in record) return record.doubleValue;
  if ("arrayValue" in record) return ((record.arrayValue as { values?: unknown[] })?.values ?? []).map(anyValue);
  if ("kvlistValue" in record) return readAttributes((record.kvlistValue as { values?: unknown[] })?.values);
  return undefined;
}

function nanosToIso(value: unknown): string {
  const nanos = typeof value === "string" || typeof value === "number" ? BigInt(value) : 0n;
  return new Date(Number(nanos / 1_000_000n)).toISOString();
}

function* logRecords(body: unknown): Generator<{ trialId: string; event: { type: string; at: string; [key: string]: unknown } }> {
  const resourceLogs = (body as { resourceLogs?: unknown[] } | undefined)?.resourceLogs;
  if (!Array.isArray(resourceLogs)) return;
  for (const resourceLog of resourceLogs as Array<{ resource?: { attributes?: unknown }; scopeLogs?: unknown[] }>) {
    const resource = readAttributes(resourceLog.resource?.attributes);
    const trialId = resource["trust.trial.id"];
    if (typeof trialId !== "string") continue;
    for (const scopeLog of (resourceLog.scopeLogs ?? []) as Array<{ logRecords?: unknown[] }>) {
      for (const record of (scopeLog.logRecords ?? []) as Array<{ timeUnixNano?: unknown; body?: unknown; attributes?: unknown; severityText?: unknown }>) {
        const attributes = readAttributes(record.attributes);
        const name = attributes["event.name"];
        const type = typeof name === "string" && name.startsWith("trust.trial.") ? name.slice("trust.trial.".length) : "log";
        const bodyText = anyValue(record.body);
        let payload: Record<string, unknown> = {};
        if (typeof bodyText === "string") {
          try {
            const parsed: unknown = JSON.parse(bodyText);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
            else payload = { text: bodyText };
          } catch {
            payload = { text: bodyText };
          }
        }
        yield { trialId, event: { ...payload, type, at: nanosToIso(record.timeUnixNano) } };
      }
    }
  }
}

function countLogRecords(body: unknown): number {
  const resourceLogs = (body as { resourceLogs?: unknown[] } | undefined)?.resourceLogs;
  if (!Array.isArray(resourceLogs)) return 0;
  return (resourceLogs as Array<{ scopeLogs?: Array<{ logRecords?: unknown[] }> }>)
    .flatMap((resourceLog) => resourceLog.scopeLogs ?? [])
    .reduce((count, scopeLog) => count + (scopeLog.logRecords?.length ?? 0), 0);
}

function* spans(body: unknown): Generator<{ trialId: string; event: { type: string; at: string; [key: string]: unknown } }> {
  const resourceSpans = (body as { resourceSpans?: unknown[] } | undefined)?.resourceSpans;
  if (!Array.isArray(resourceSpans)) return;
  for (const resourceSpan of resourceSpans as Array<{ resource?: { attributes?: unknown }; scopeSpans?: unknown[] }>) {
    const resource = readAttributes(resourceSpan.resource?.attributes);
    const trialId = resource["trust.trial.id"];
    if (typeof trialId !== "string") continue;
    for (const scopeSpan of (resourceSpan.scopeSpans ?? []) as Array<{ spans?: unknown[] }>) {
      for (const span of (scopeSpan.spans ?? []) as Array<{ name?: unknown; spanId?: unknown; parentSpanId?: unknown; startTimeUnixNano?: unknown; endTimeUnixNano?: unknown; attributes?: unknown; status?: { code?: unknown } }>) {
        yield {
          trialId,
          event: {
            type: "span",
            at: nanosToIso(span.endTimeUnixNano),
            name: typeof span.name === "string" ? span.name : "",
            spanId: span.spanId,
            parentSpanId: span.parentSpanId,
            startedAt: nanosToIso(span.startTimeUnixNano),
            endedAt: nanosToIso(span.endTimeUnixNano),
            ok: span.status?.code !== 2,
            attributes: readAttributes(span.attributes),
          },
        };
      }
    }
  }
}
