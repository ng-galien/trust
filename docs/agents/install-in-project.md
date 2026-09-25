# Use TRUST from another project

An open TRUST UI does not install a skill or connect another project's agent.
Install two local skills and configure that project's MCP and Runner endpoints.

```text
User request
  → trust-operations (local entry and scoping)
  → TRUST MCP: agents/SKILL → selected recipe → technical reference
  → author and verify the project's Procedure and Operations
  → publish / engage when authorized, or resume the assigned Plan
  → trust (local packaged Runner) → supplied Check URI
  → TRUST verdict and next Checks
```

## Install the two skills

For Codex, use `<project>/.agents/skills/`:

```text
.agents/skills/
  trust-operations/
    SKILL.md                 # Loads the runtime's operational guide
    agents/openai.yaml
    references/project.md    # Optional project scope and actual endpoints
  trust/
    SKILL.md                 # Executes supplied Check URIs
    agents/openai.yaml
    references/results.md
    scripts/                 # Compiled, standalone Runner
```

Copy `assets/skills/trust-operations` from a TRUST installation to the first
directory. Do not copy `docs/agents/SKILL.md` alone: its repository links need
the documentation catalog's rewritten links and MCP reader.

Deploy the complete Runner to the second directory with the installed shell:

```sh
trust runner deploy /absolute/project/.agents/skills/trust
```

From a built TRUST checkout, the equivalent command is:

```sh
TRUST_INSTALL_ROOT=/absolute/trust \
  node /absolute/trust/packages/trust-shell/dist/src/cli.js \
  runner deploy /absolute/project/.agents/skills/trust
```

Deployment replaces that exact Runner directory atomically. Inspect an existing
destination first. Do not copy only its source `SKILL.md`: the bundled scripts are
required. Use the Node version required by the installed TRUST distribution.

## Connect the same runtime twice

Merge these entries into the project's `.codex/config.toml`, preserving its other
settings. This example uses a runtime listening on port 4498; use the actual
runtime's endpoints. Project configuration applies to a trusted Codex project.

```toml
[mcp_servers.trust]
url = "http://127.0.0.1:4498/mcp"
enabled = true

[shell_environment_policy.set]
TRUST_RPC_ENDPOINT = "http://127.0.0.1:4498/rpc"
TRUST_OTLP_ENDPOINT = "http://127.0.0.1:4498/v1/traces"
```

Merge keys into an existing table; do not duplicate the TOML table. The MCP reads
documentation, authors sources and reads Plans. The Runner uses RPC to obtain its
Operation and OTLP to submit Facts. An MCP URL alone does not configure the Runner.
An agent host other than Codex must pass the same endpoint variables explicitly.
Localhost refers to the agent's machine, not a remote server.

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
  Reload the MCP connection after changing its configuration.
- Read `agents/SKILL` and one recipe through the connected MCP. Check the scoping
  introduction and follow pagination. Do not treat files on disk as proof of what
  the running server serves.
- Verify all Runner bundle files exist. A no-argument invocation prints usage and
  exits 2 without executing a Check; it proves startup, not live execution.
- Documentation changes require repackaging (`npm run package:documentation
  --workspace=@trust/runtime` in a checkout) and a runtime restart to clear its
  cache. Preserve and back up retained data before any runtime change.
- Update the Runner by redeploying it. General recipe updates stay on the server;
  project endpoint and method choices stay in the target project.

Host details: [Codex skills](https://learn.chatgpt.com/docs/build-skills) and
[MCP configuration](https://learn.chatgpt.com/docs/extend/mcp).
