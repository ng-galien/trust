# TRUST

TRUST is being rebuilt as a current runtime for agent-operated software tasks.

The active product has four parts:

- `apps/trust-runtime`: the private runtime, including domain, application services, persistence,
  RPC, MCP and OTLP boundaries;
- `packages/trust-operation`: Operation types shared by the runtime and the runner;
- `packages/trust-procedure`: Procedure types and Gherkin compiler;
- `packages/trust-runner`: the generic runner that receives one Check URI and executes the
  definition returned by TRUST.

The product contract is documented in [`docs/`](docs/README.md).
