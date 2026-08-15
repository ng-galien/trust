# TRUST server

TRUST runs as one persistent development server with disposable state.

```text
server + RPC + MCP + OTLP  http://127.0.0.1:4318
database                    .trust/server/runtime.sqlite
principal configuration     .trust/server/generated/registry-principals.json
tmux                         trust:server
environment                  trust-test
```

There is no server or database per ticket, no retained copy of the disposable database, and no separate
compiler or Skill server. The six source Skills run as short-lived Bun processes for one Check URI.

## Commands

Load the local environment without printing it:

```sh
source .trust/server/environment
```

Operate the server through one command:

```sh
# Start the server if absent and keep its current disposable database.
bun scripts/server.ts start

# Delete the database, restart the same server, and seed it.
bun scripts/server.ts reset

# Republish all procedures.
bun scripts/server.ts seed
```

Development mode builds once, watches TypeScript output, and reloads the process on the same
endpoint. Feature and Skill changes require `seed`, not another server.

`reset` removes only this disposable database family:

```text
.trust/server/runtime.sqlite
.trust/server/runtime.sqlite-wal
.trust/server/runtime.sqlite-shm
.trust/server/runtime.sqlite.trust-process-lock
```

## Seed and preflight

`seed` publishes every Feature under `assets/procedures/`.

Before delegating a ticket, verify the exact boundary used by the agent:

```sh
bun scripts/server.ts preflight \
  --ticket '<TICKET>' \
  --procedure '<PROCEDURE>' \
  --version '<VERSION>'
```

The preflight checks the server, the exact published procedure, the MCP tools, the execution
credentials, the Jira issue, and governed Git then Jira roundtrips. A failure blocks delegation.

## Public verification

```sh
node --test acceptance/runtime-mcp-agent-loop.acceptance.test.mjs
```
