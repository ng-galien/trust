# TRUST Operation catalog

An Operation describes how to call one external system and which typed fields that call produces.
It does not define a Check, a Plan, qualification or an OpenTelemetry envelope.

Every `.feature` in this directory is executable source for `@trust/operation`. The compiler emits
one `CompiledOperation`; the runner executes only that compiled object.

## Closed language

An Operation contains:

- one stable `@operation:<domain>.<action>` name and semantic version;
- one `Feature:` title and, optionally, a free-text description block right under it (plain
  Gherkin description): it explains what the Operation observes for humans and is reported by the
  compiler as `description`, never used by execution;
- typed `Input` supplied by the Procedure Check;
- typed `Environment` supplied by execution configuration;
- ordered Shell, File-read or HTTP-GET steps;
- one final JSONata expression;
- the exact typed fields produced by that expression;
- optional free classification tags `@x-<key>:<value>` (for example `@x-family:software-delivery`
  `@x-nature:observe @x-team:platform`): any lower-case key, repeatable, opaque to execution and
  reported by the compiler as `classification` grouped by key. Operators classify as they see fit.

The current value types are `string`, `number`, `instant` and `reference`. Cardinality is `one` or
`many`. Environment values are `directory` or `url`.

A directory Environment names the place where all projects live. A Shell or File step may narrow
it to one project with `with cwd from Environment "workspaceRoot" and Input "project"` (or `File …
from Environment "workspaceRoot" and Input "project"`): the Input must be one string naming a
directory directly below the root — no path separators, no traversal, no symbolic link out of the
root. Without the `and Input` clause the step runs in the Environment directory itself.

Shell arguments are structured. Each row is one argv token: `literal` (the cell as-is), `Input
"<name>"` (the value of one string Input) or `literal + Input "<name>"` (the cell as a prefix glued
to the value of one string Input, no separator: `-Dtrust.ticket=` + `TK-8` gives `-Dtrust.ticket=TK-8`).
The runner never parses a shell command line. Exit code `0` is expected by default. An Operation may
declare other expected exits and may require exact text to occur in their standard output or error
output. An expected exit remains a step result and can produce fields. Any other exit interrupts
the Operation before fields are produced. This distinction lets a failing test be an expected
observation without mistaking a compilation or infrastructure error for that observation.

HTTP GET can use an Environment URL directly, append string Inputs as successive encoded path
segments (`appending Input "a" and Input "b"`) and add named query parameters, each from one string
Input or one literal (`with query "limit" as "5" with query "run" from Input "run"`), in that clause
order, before `as Text|JSON`. The Environment URL must not already carry a query string when the step
declares one. HTTP POST sends the complete typed Input as one JSON object and reads one JSON response;
it accepts no path segment or query. There is no authored header, body template or free URL
interpolation. File read accepts one fixed relative path below a directory Environment.

Every step result has one stable shape:

```text
Shell     -> exitCode, stdout, stderr
File Text -> relativePath, content
File JSON -> relativePath, content
HTTP      -> status, headers, body
```

`Produce with JSONata` sees `input`, `environment` and `steps`. It must return exactly the declared
fields. The JSONata subset is closed by the compiler.

A field copied from `input` attests the admitted context used by the executed action. It does not
claim that the external system independently re-observed that value. Step-derived fields attest
the action result itself.

## Catalog purpose

The software Operations exercise Git, Jira, Maven, Karate, Playwright, Docker, Kind, Kubernetes and
trace reading. The healthcare, aviation and food Operations call simulated HTTP endpoints. They are
language examples and runner smoke-test inputs, not claims that TRUST contains professional domain
rules.

An Operation is reusable. A compiled Procedure embeds the exact compiled Operations it uses, so a
later catalog change cannot silently change an existing Procedure revision.
