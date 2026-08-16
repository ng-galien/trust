# TRUST

TRUST is being rebuilt as a current runtime for agent-operated software tasks.

The active product has four parts:

- `packages/trust-runtime`: the shared runtime for Procedures, Plans, Checks, SQLite, RPC,
  MCP and OTLP;
- `packages/trust-operation`: Operation types shared by the runtime and the runner;
- `packages/trust-procedure`: Procedure types and Gherkin compiler;
- `packages/trust-runner`: the generic runner that receives one Check URI and executes the
  definition returned by TRUST.
