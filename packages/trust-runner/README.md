# TRUST runner

The runner receives one semantic Check URI from an agent.

TRUST returns the Operation for that Check. The runner executes its Shell, File or HTTP Steps, sends the
resulting Facts through OTLP, and returns the checklist verdict.

Each Fact is one OpenTelemetry span event. Correlation stays on the span. Every Fact field is an
event attribute under `trust.fact.*`; strings, numbers, booleans, arrays and objects use native OTLP
values. Facts are never hidden in a serialized JSON attribute.

```sh
npm run package:skill
node packages/trust-runner/dist/skill/trust/scripts/run.js trust://authority/procedure@1.0.0/plan/scenario/action/target
```

The same runner is available through MCP STDIO:

```sh
node packages/trust-runner/dist/skill/trust/scripts/mcp-stdio.js
```

## Trial runs and diagnostics

TRUST can run one Operation for real, outside any Plan or Check, to validate it. The runtime spawns
the packaged `scripts/trial.js` with one `trust.trial-job@1` document on stdin (compiled operation,
input, environment values, diagnostics endpoint) and reads one `trust.trial-outcome@1` document on
stdout.

While it runs, the runner pushes diagnostics as standard OTLP/JSON: one log record per event
(`/v1/logs`: operation and step start/end, stdout/stderr chunks, HTTP request/response dumps, file
reads) and one span per step and per operation (`/v1/traces`), all under the `trust.trial.id`
resource attribute. The runtime's diagnostic receiver (`/otlp/diagnostics`) keeps them in memory and
streams them over SSE (`/otlp/diagnostics/trials/:id/stream`); nothing becomes a Fact.

```sh
echo '{"contract":"trust.trial-job@1", ...}' | node packages/trust-runner/dist/skill/trust/scripts/trial.js
```
