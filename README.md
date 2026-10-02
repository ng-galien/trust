# TRUST

TRUST governs the work of coding agents with Plans and Checks. A Procedure states
which Checks a Plan contains and what each Check must establish. To run a Check,
an agent gives its URI to the Runner. The Runner executes the Check's Operation and
reports the observed values, called Facts. TRUST qualifies those Facts against
the Procedure and returns the verdict: `VALIDATED` or `NOT_VALIDATED`.

The agent never writes its own evidence. It cannot declare a Check satisfied or
submit Facts for an action the Runner did not perform. Facts and verdicts are kept
as an immutable history.

[TRUST documentation](https://ng-galien.github.io/trust/)

## Prerequisites

- Node.js 24.10.0 or later, with npm
- Git and curl for the quickstart example
- Claude Code or Codex in the projects you connect

## Install

```sh
npm install --global @ng-galien/trust
trust --version
```

The package `@ng-galien/trust` contains the runtime, the web interface, the
Runner and the agent skills. No clone or build is needed. `npx @ng-galien/trust`
runs it without a global installation.

## Start the server

```sh
trust start --port 4173 --data-dir "$HOME/.trust/server"
```

The command prints the interface, RPC, MCP and OTLP addresses. All of them go
through the public port. The data directory holds the database, published
Procedures and Plans. `trust --help` lists the options.

## Connect a project

```sh
trust setup /path/to/project --url http://127.0.0.1:4173
```

For Claude Code, setup installs `.claude/skills/trust-operations` and the
Runner in `.claude/skills/trust`. It declares the MCP server in `.mcp.json` and
the Runner endpoints in `.claude/settings.json`. For Codex, it uses
`.agents/skills` and `.codex/config.toml`. `--agent claude-code` or `--agent codex`
selects one agent. Setup can run again and keeps unrelated configuration.

## Next steps

- [QUICKSTART.md](QUICKSTART.md): install, start, connect a project, publish a
  Procedure, engage a Plan and run a first Check, with the expected output of
  each step.
- [Project installation](docs/agents/install-in-project.md): what setup writes
  for Claude Code and Codex, and how to verify it.
- [Operational guide for agents](docs/agents/SKILL.md): modelling Procedures,
  delegation and execution.
- [Integrated documentation](packages/trust-ui/src/docs/content/en/index.mdx):
  concepts, the Operation and Procedure languages and the screens. The running
  server serves it at `/docs`, and agents read it through MCP with
  `trust_documentation_read`.
- [Command reference](packages/trust-shell/README.md): every `trust` command and
  the package layout.

## License

[MIT](LICENSE)
