# @ng-galien/trust

The `trust` command runs a complete local TRUST server: the runtime, the web
interface, RPC, MCP and OTLP. It also connects a project's coding agent to that
server. The package contains everything already built; it needs Node.js
24.10 or later and no clone or build of the TRUST repository.

## Start a server

```sh
npx @ng-galien/trust start --port 4173 --data-dir ~/.trust/server
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--port` | `4173` | Public port: web interface, `/rpc`, `/mcp` and `/v1/traces` |
| `--runtime-port` | `4318` | Internal runtime port, reached through the public port |
| `--data-dir` | `.trust/server` in the current directory | Database, Operations, packages and keys |
| `--host` | `127.0.0.1` | Listening address |

The command prints the interface, RPC, MCP and OTLP addresses and keeps running
until it receives `SIGINT` or `SIGTERM`. `trust --version` prints the installed
version and `trust --help` lists the commands.

## Connect a project

```sh
npx @ng-galien/trust setup /path/to/project --url http://127.0.0.1:4173
```

| Agent | Skills and Runner | MCP server | Runner endpoints |
| --- | --- | --- | --- |
| Claude Code (`--agent claude-code`) | `.claude/skills/trust-operations`, `.claude/skills/trust` | `.mcp.json` → `mcpServers.trust` | `.claude/settings.json` → `env` |
| Codex (`--agent codex`) | `.agents/skills/trust-operations`, `.agents/skills/trust` | `.codex/config.toml` → `[mcp_servers.trust]` | `.codex/config.toml` → `[shell_environment_policy.set]` |

Without `--agent`, both agents are configured. Without `--url`, the server URL
comes from `TRUST_URL`, then from the default `http://127.0.0.1:4173`.

Setup can run again. It replaces the Runner directory, refreshes the files of the
`trust-operations` skill and writes only the TRUST entries: `mcpServers.trust`, the
two endpoint variables, and the Codex `[mcp_servers.trust]` table, which is
replaced as a whole (with its sub-tables). Other files, MCP servers, environment
variables, TOML tables and comments are kept as found. Every selected agent's
configuration is validated before any file is written: invalid JSON or TOML, or
TRUST entries written as inline tables, dotted keys or multi-line values, refuse
the whole setup and leave the project unchanged.

## Call the runtime

```sh
TRUST_URL=http://127.0.0.1:4173 trust rpc plan.read '{"plan":"quickstart"}' --field workState
```

`trust rpc <method> [<json-params>]` calls one runtime RPC method on the server
named by `TRUST_URL` and prints the JSON result. `--text <field>=<file>` places a
file's content in a string parameter, for example a Procedure source.
`--field <path>` prints one value of the result, such as `checkUris.0`.

Other commands: `trust server status`, `trust server config`,
`trust runner deploy <absolute-directory>` and `trust registry …`.

## Package layout

The published package is assembled from a built checkout. Workspace packages
(`@trust/*`) are never published; they are inlined by bundling:

```text
LICENSE                      MIT license
bin/trust.js                 command entry
lib/cli.js                   shell CLI bundle (shell, extension SDK and TOML parser)
lib/runtime/index.js         runtime bundle (runtime, language packages and libraries)
lib/runtime/child.js         extension host child process bundle
documentation/catalog.json   documentation served by MCP
web/                         built web interface
operations/                  built-in Operation sources
skills/trust/                packaged Runner skill (bundled scripts)
skills/trust-operations/     operational skill
node_modules/@electric-sql/pglite   bundled dependency (WebAssembly and data files)
```

PGlite stays a bundled dependency because it loads its WebAssembly and data files
relative to its own modules. Source maps, type declarations, tests and
development data are not packaged. Installing the archive needs no registry
access.

## Build and publish (maintainers)

From a checkout whose `npm ci` has run:

```sh
npm run build
npm run package:npm -- --output /absolute/empty/directory
npm pack <staged-directory> --pack-destination /absolute/archives
npm publish /absolute/archives/ng-galien-trust-<version>.tgz --access public
```

`<staged-directory>` is the real path printed by `package:npm`: npm omits bundled
dependencies when it packs through a symbolic link. The acceptance test
`acceptance/npm-package.acceptance.test.mjs` stages, packs and installs the same
archive in an empty directory before exercising it.
