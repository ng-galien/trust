# TRUST runtime

`@trust/runtime` is the private runtime shared by server, VS Code and Electron hosts.
It compiles and publishes Procedures, engages Plans, admits Check attempts, receives Facts through
OTLP, qualifies Checks and exposes the resulting state through RPC and MCP.

The package uses the same product language as the Procedure and Operation packages. An admitted
attempt receives the exact Operation embedded in its published Procedure. The runner executes that
Operation and submits its Facts. TRUST validates the complete Fact batch before persistence, then
returns `VALIDATED` or `NOT_VALIDATED` with a reason and the checklist delta.

## Source layout

```text
src/
  procedure/   compile, publish and read Procedures
  plan/        engage and read Plans; admit and finalize Check attempts
  check/       Check URIs, dependencies and qualification
  skill/       optional verified-Skill policy
  sqlite/      runtime schema and stores
  http/        health, RPC, MCP and OTLP endpoints
  runtime.ts   process assembly
  server.ts    HTTP server lifecycle
```

The first four directories follow product concepts. `sqlite` and `http` name concrete mechanisms.
There are no application, domain, port, adapter or presentation layers.

## Public verification

Acceptance tests start the real HTTP runtime. They currently verify:

- health;
- Procedure compilation, publication and reading with the exact compiled Operation;
- a complete Git status run through admission, the generic runner, OTLP Facts and finalization.

Run them with:

```sh
npm run test:acceptance --workspace=@trust/runtime
```

The normative product boundary remains
[TRUST V1 — minimal product scope](../../docs/product/v1-minimal-scope.md).
