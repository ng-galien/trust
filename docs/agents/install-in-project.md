# Use TRUST from another project

An open TRUST UI does not install a skill or connect another project's agent.
`trust setup` installs two local skills and the packaged Runner in the project,
and points the project's agent at one TRUST server through MCP, RPC and OTLP.

```text
User request
  → trust-operations (local entry and scoping)
  → TRUST MCP: agents/SKILL → selected recipe → technical reference
  → author and verify the project's Procedure and Operations
  → publish / engage when authorized, or resume the assigned Plan
  → trust (local packaged Runner) → supplied Check URI
  → TRUST verdict and next Checks
```

## Install TRUST and connect the project

Install the `trust` command from npm (`npm install --global @ng-galien/trust`)
and start a server (`trust start`). The repository's `QUICKSTART.md` gives the
complete sequence with expected outputs. Then connect the project:

```sh
trust setup /absolute/project --url http://127.0.0.1:4173
```

Use the server's public address, as printed by `trust start`. Without `--url`,
setup uses `TRUST_URL`, then `http://127.0.0.1:4173`. Without `--agent`, setup
configures Claude Code and Codex; `--agent claude-code` or `--agent codex` selects
one.

| Agent | Skills and Runner | MCP server | Runner endpoints |
| --- | --- | --- | --- |
| Claude Code | `.claude/skills/trust-operations`, `.claude/skills/trust` | `.mcp.json`: `mcpServers.trust` | `.claude/settings.json`: `env` |
| Codex | `.agents/skills/trust-operations`, `.agents/skills/trust` | `.codex/config.toml`: `[mcp_servers.trust]` | `.codex/config.toml`: `[shell_environment_policy.set]` |

For Codex, the result looks like this, with the server's address:

```toml
[mcp_servers.trust]
url = "http://127.0.0.1:4173/mcp"
enabled = true

[shell_environment_policy.set]
TRUST_RPC_ENDPOINT = "http://127.0.0.1:4173/rpc"
TRUST_OTLP_ENDPOINT = "http://127.0.0.1:4173/v1/traces"
```

Claude Code receives the same values: `mcpServers.trust` is
`{"type": "http", "url": ".../mcp"}`, and `env` sets `TRUST_RPC_ENDPOINT` and
`TRUST_OTLP_ENDPOINT`. The MCP reads documentation, authors sources and reads
Plans. The Runner uses RPC to obtain its Operation and OTLP to submit Facts. An
MCP URL alone does not configure the Runner. An agent host other than Claude Code
or Codex must pass the same endpoint variables explicitly. Localhost refers to the
agent's machine, not a remote server. Codex applies project configuration to a
trusted project.

## What setup preserves

- The `trust` Runner directory is replaced atomically. Do not edit it: the bundled
  scripts are generated.
- The files of `trust-operations` are refreshed. Files added beside them, such as
  `references/project.md` for project scope and actual endpoints, are kept.
- Only the TRUST entries are written: `mcpServers.trust`, the two endpoint
  variables and the Codex `[mcp_servers.trust]` table, which is replaced as a
  whole. Other servers, variables, tables and comments are kept.
- Every selected agent's configuration is validated before any file is written.
  Invalid JSON or TOML, or TRUST entries written as inline tables, dotted keys or
  multi-line values, refuse the setup and leave the project unchanged.

Setup can run again. It changes nothing when the project is already connected to
the same server. Run it with the new `--url` to move the project to another server.

## Without the npm package

From a built TRUST checkout, the same command runs through the checkout's shell:

```sh
TRUST_INSTALL_ROOT=/absolute/trust \
  node /absolute/trust/packages/trust-shell/bin/trust.js \
  setup /absolute/project --url http://127.0.0.1:4173
```

`trust runner deploy <absolute-directory>` deploys only the Runner, for an agent
host that setup does not configure. Use the Node version required by the
installed TRUST distribution.

## Use it in the target project

```text
$trust-operations Help me model feature refinement for this project.
Clarify the perimeters, participants, external systems and completion criteria
before choosing a recipe. Produce a verified draft.
```

For an existing assignment:

```text
$trust Resume the assigned Plan <plan-id> within its authorized scope.
Read the Plan, then execute its supplied Check URIs with the installed Runner.
```

The agent reads instructions as needed; it does not load every guide at startup.
Do not create a skill for every feature. Reusable method rules belong in Procedures
and Operations; an optional project skill can route recurring requests to those
approved methods without copying the grammar or general recipes.

## Verify discovery and keep it current

- Open a task in the target project and check that both skills are available.
  Codex detects skill changes automatically; restart Codex if they do not appear.
  Restart Claude Code or reload the MCP connection after setup.
- Read `agents/SKILL` and one recipe through the connected MCP. Check the scoping
  introduction and follow pagination. Do not treat files on disk as proof of what
  the running server serves.
- Run the Runner without arguments: it prints its usage and exits 2 without
  executing a Check. This proves startup, not live execution. A first live Check
  is described in `QUICKSTART.md`.
- After a TRUST update, run `trust setup` again to refresh the skills and the
  Runner. General recipe updates stay on the server; project endpoint and method
  choices stay in the target project.
- In a checkout, documentation changes require repackaging (`npm run
  package:documentation --workspace=@trust/runtime`) and a runtime restart to clear
  its cache. Preserve and back up retained data before any runtime change.

Codex host details: [Codex skills](https://learn.chatgpt.com/docs/build-skills) and
[MCP configuration](https://learn.chatgpt.com/docs/extend/mcp).
