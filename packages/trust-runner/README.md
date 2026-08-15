# TRUST runner

The runner receives one semantic Check URI from an agent.

TRUST returns the Operation for that Check. The runner executes its Shell, File or HTTP Steps, sends the
resulting Facts through OTLP, and returns the checklist verdict.

Each Fact is one OpenTelemetry span event. Correlation stays on the span. Every Fact field is an
event attribute under `trust.fact.*`; strings, numbers, booleans, arrays and objects use native OTLP
values. Facts are never hidden in a serialized JSON attribute.

```sh
bun packages/trust-runner/scripts/run.ts trust://authority/procedure@1.0.0/plan/scenario/action/target
```

The same runner is available through MCP STDIO:

```sh
bun packages/trust-runner/scripts/mcp-stdio.ts
```
