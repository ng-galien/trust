# TRUST quickstart

This guide installs TRUST from npm, starts a local server, connects a project and
runs a first Check. It is written for a coding agent: run the shell blocks in
order, in one shell session (bash or zsh), and compare each result with the
expected output.

The commands use these defaults:

| Value | Default | Change it when |
| --- | --- | --- |
| Public server port | `4173` | another service uses it; replace it in every block |
| Internal runtime port | `4318` | another service uses it; replace it in every block |
| TRUST files | `$HOME/.trust` | never required |
| Example project | `$HOME/projects/demo` | you connect another project |

## 1. Check the prerequisites

```sh
node --version
npm --version
git --version
curl --version
```

Expected output: Node.js `v24.10.0` or later, then one version line for npm, Git
and curl. Stop if Node.js is older: the package declares `node >=24.10.0`.

## 2. Install the `trust` command

```sh
npm install --prefix "$HOME/.trust/cli" @ng-galien/trust
export PATH="$HOME/.trust/cli/node_modules/.bin:$PATH"
trust --version
```

Expected output: npm reports `added 1 package`, then the installed version, for
example `0.1.0`. The package contains the runtime, the web interface, the Runner
and the agent skills. No clone or build is needed. This guide installs into
`$HOME/.trust/cli`, which needs no administrator rights;
`npm install --global` works as well.

## 3. Start the server

```sh
mkdir -p "$HOME/.trust"
trust start --port 4173 --runtime-port 4318 --data-dir "$HOME/.trust/server" > "$HOME/.trust/server.log" 2>&1 &
echo $! > "$HOME/.trust/server.pid"
for attempt in $(seq 1 60); do curl -fs http://127.0.0.1:4173/health > /dev/null && break; sleep 1; done
curl -fsS http://127.0.0.1:4173/health
echo
cat "$HOME/.trust/server.log"
export TRUST_URL=http://127.0.0.1:4173
```

Expected output:

```text
{"status":"ok","service":"trust-runtime","currentTime":"..."}
TRUST server: running at http://127.0.0.1:4173
TRUST interface: http://127.0.0.1:4173/
TRUST RPC: http://127.0.0.1:4173/rpc
TRUST MCP: http://127.0.0.1:4173/mcp
TRUST OTLP: http://127.0.0.1:4173/v1/traces
TRUST runtime: http://127.0.0.1:4318
TRUST data: /home/you/.trust/server
Connect a project: trust setup <project-directory> --url http://127.0.0.1:4173
```

The server keeps running in the background. Its database and settings live in
`$HOME/.trust/server`. `TRUST_URL` tells `trust rpc` which server to call.

## 4. Connect a project

The example project contains one Git repository, `app`, that the first Check
observes.

```sh
mkdir -p "$HOME/projects/demo/app"
cd "$HOME/projects/demo/app"
git init --quiet
printf '# Demo application\n' > README.md
git add README.md
git -c user.name="TRUST quickstart" -c user.email=quickstart@example.invalid commit --quiet -m "Initial commit"
cd "$HOME/projects/demo"
trust setup "$HOME/projects/demo" --url http://127.0.0.1:4173
ls .claude/skills .agents/skills
```

Expected output:

```text
TRUST setup (claude-code): /home/you/projects/demo
  skills: /home/you/projects/demo/.claude/skills (trust-operations, trust Runner)
  MCP: /home/you/projects/demo/.mcp.json -> http://127.0.0.1:4173/mcp
  Runner endpoints: /home/you/projects/demo/.claude/settings.json -> http://127.0.0.1:4173/rpc, http://127.0.0.1:4173/v1/traces
TRUST setup (codex): /home/you/projects/demo
  skills: /home/you/projects/demo/.agents/skills (trust-operations, trust Runner)
  MCP: /home/you/projects/demo/.codex/config.toml -> http://127.0.0.1:4173/mcp
  Runner endpoints: /home/you/projects/demo/.codex/config.toml -> http://127.0.0.1:4173/rpc, http://127.0.0.1:4173/v1/traces
.agents/skills:
trust
trust-operations

.claude/skills:
trust
trust-operations
```

`--agent claude-code` or `--agent codex` limits setup to one agent. Setup can run
again; it keeps unrelated configuration. Restart Claude Code or Codex in the
project to load the skills and the MCP server.

Claude Code and Codex pass the Runner endpoints from the project configuration.
A plain shell must export them:

```sh
export TRUST_RPC_ENDPOINT=http://127.0.0.1:4173/rpc
export TRUST_OTLP_ENDPOINT=http://127.0.0.1:4173/v1/traces
```

## 5. Pick an Operation and publish a Procedure

An Operation is a reusable action that produces typed Facts. TRUST carries no
Operation: a project writes or imports the ones it needs. This one reads a
repository's HEAD and working tree with two `git` commands.

```sh
mkdir -p trust
cat > trust/git.head-read.feature <<'EOF'
# language: en
@trust-dsl:1 @operation:git.head-read @version:1.0.0
Feature: Read Git HEAD and working tree

  Background: Operation interface
    Given Environment
      | name          | type      |
      | workspaceRoot | directory |
    And Input
      | input   | type      | cardinality |
      | project | reference | one         |
    And Produced fields
      | field        | type      | cardinality | domain                |
      | headRevision | reference | one         | any                   |
      | workingTree  | string    | one         | enum "clean", "dirty" |

  Scenario: Run
    When Shell "head" runs "git" with cwd from Environment "workspaceRoot" and Input "project"
      | argument  | source  |
      | rev-parse | literal |
      | --verify  | literal |
      | HEAD      | literal |
    And Shell "status" runs "git" with cwd from Environment "workspaceRoot" and Input "project"
      | argument                 | source  |
      | status                   | literal |
      | --porcelain=v1           | literal |
      | --untracked-files=normal | literal |
    Then Produce with JSONata
      """
      {
        "headRevision": $trim(steps.head.stdout),
        "workingTree": $trim(steps.status.stdout) = "" ? "clean" : "dirty"
      }
      """
EOF
trust rpc operation.save '{"sourceName":"git.head-read.feature"}' --text source=trust/git.head-read.feature --field operation.title
```

Expected output: `Read Git HEAD and working tree`. A published Operation version is
immutable, like a Procedure version.

A Procedure states which Checks a Plan contains and what each Check must
establish. This one asks for a local change in the observed repository. The agent
may edit files; it may not commit or reset to change the observed state.

```sh
cat > trust/repository-change.feature <<'EOF'
# language: en
@trust-dsl:1 @procedure:repository-change @version:1.0.0
Feature: Establish that a repository carries a local change

  Background: Plan context
    Given Procedure scope
      | check | authorized                                     | forbidden                                            |
      | all   | Edit files of the repository to make a change. | Commit, reset or stash to change the observed state. |
    Given one reference "repository"

  @scenario:repository-status
  Scenario: Observe the repository
    Then Check "repository status" runs Operation "git.head-read@1.0.0" on "repository" as Input "project" and must establish "the repository has local changes"
      """js
      fact.workingTree === "dirty" ||
      fail("the repository has no local changes")
      """
EOF
trust rpc procedure.publish '{"sourceName":"repository-change.feature"}' --text source=trust/repository-change.feature --field procedure.title
```

Expected output: `Establish that a repository carries a local change`. A
published version is immutable; a changed source is published under a new
version.

## 6. Engage a Plan

An Environment holds the values an Operation needs on this machine. Here,
`workspaceRoot` is the directory that contains the observed repository.

```sh
trust rpc environment.save "{\"environment\":\"demo\",\"values\":{\"workspaceRoot\":\"$HOME/projects/demo\"}}" --field environment.name
trust rpc plan.engage '{"contract":"trust.plan-engagement-request@1","procedure":"repository-change","procedureVersion":"1.0.0","plan":"quickstart","environment":"demo","rootInputs":{"repository":"app"}}' --field status
CHECK_URI=$(trust rpc plan.read '{"plan":"quickstart"}' --field actionableChecks.0)
echo "$CHECK_URI"
```

Expected output:

```text
demo
ENGAGED
trust://127.0.0.1:4318/repository-change@1.0.0/quickstart/repository-status/check-.../git-head-read
```

The Check URI comes from TRUST. Never build or edit one.

## 7. Run the first Check

The installed Runner executes the Operation, reports its Facts, and prints the
verdict TRUST computed. Run it on the unchanged repository:

```sh
node .claude/skills/trust/scripts/run.js "$CHECK_URI" --json
```

Expected output (abridged):

```text
"status": "COMPLETED",
"verdict": "NOT_VALIDATED",
"reason": "the repository has no local changes",
"action": "RETRY_OR_ESCALATE",
```

The Check stays open. Do the work the Procedure asks for, then run the same Check
again:

```sh
printf 'First change made by the agent.\n' >> app/README.md
node .claude/skills/trust/scripts/run.js "$CHECK_URI" --json
trust rpc plan.read '{"plan":"quickstart"}' --field workState
```

Expected output (abridged):

```text
"status": "COMPLETED",
"verdict": "VALIDATED",
"reason": "the repository has local changes",
"action": "COMPLETE"
COMPLETE
```

The agent did not declare the result. The Runner observed the repository, and
TRUST qualified the Facts against the Procedure. A Codex agent runs the same
script from `.agents/skills/trust/scripts/run.js`.

## 8. Stop the server

```sh
kill "$(cat "$HOME/.trust/server.pid")"
```

Run the step 3 commands again to restart it. Plans and published Procedures are
kept in `$HOME/.trust/server`.

## Continue

- Inside Claude Code or Codex, ask the agent to use the `trust-operations` skill.
  It reads the server's guides through MCP (`trust_documentation_read`) and uses
  MCP tools such as `trust_procedure_publish`, `trust_plan_engage` and
  `trust_plan_read` instead of `trust rpc`.
- Run Checks with the `trust` skill: it passes one Check URI to the Runner.
- Open `http://127.0.0.1:4173/` for the web interface and its documentation.
