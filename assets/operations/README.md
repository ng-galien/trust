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
- optional `Credentials`: the names of Environment secrets that its steps reference explicitly;
- ordered Shell, File-read, HTTP or PostgreSQL steps;
- one final JSONata expression;
- the exact typed fields produced by that expression;
- optional free classification tags `@x-<key>:<value>` (for example `@x-family:software-delivery`
  `@x-nature:observe @x-team:platform`): any lower-case key, repeatable, opaque to execution and
  reported by the compiler as `classification` grouped by key. Operators classify as they see fit.

The current value types are `string`, `number`, `instant` and `reference`. Cardinality is `one` or
`many`. Environment values are `directory`, `url` or non-empty `string`.

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

One HTTP sentence sends any registered application request method, including the RFC 10008 `QUERY`
method. `PRI` and the reserved `*` token are protocol control values and cannot be sent. Every method
uses the same ordered clauses: encoded path segments from Inputs or literals; query parameters and
headers from Inputs, string Environments or literals; then an optional complete Input JSON body,
closed JSONata JSON body or Text body. The response is read as JSON, Text or no body. An Operation may
replace the default accepted `200`-`299` range with an exact status table. The Environment URL must
not already carry a query string when the step declares one. There is no free URL interpolation.
File read accepts one fixed relative path below a directory Environment.

## Credentials

An Operation that needs a secret (a token, a database password) declares it by name in its
interface and references it explicitly from the step that uses it. The source never contains the
value.

```gherkin
Given Environment
  | name        | type      |
  | serviceUrl  | url       |
  | databaseUrl | string    |
  | root        | directory |
And Credentials
  | name        |
  | apiToken    |
  | dbPassword  |
  | deployToken |
```

`Credentials` is a one-column `name` table. A name starts with a letter and uses letters, digits or
underscores; it is the name of a Credential stored for the Environment. Each Credential is
referenced in one of three places:

```gherkin
When HTTP "call" sends "GET" to Environment "serviceUrl"
    with header "Authorization" from Credential "apiToken" and reads JSON
And PostgreSQL "query" executes SQL on Environment "databaseUrl"
    authenticated by Credential "dbPassword" with Input as JSONB parameter $1
And Shell "deploy" runs "deploy" with cwd from Environment "root"
    with variable "DEPLOY_TOKEN" from Credential "deployToken"
```

- An HTTP header takes its value from the Credential (`from Credential` is accepted for headers
  only, never for path, query or body).
- A PostgreSQL connection authenticates with the Credential as its password.
- A Shell step receives the Credential as one process variable, for that step only. A step may
  declare several variables with repeated `with variable` clauses; names are unique per step.

The compiler refuses a reference to an undeclared Credential, a repeated or malformed name, and a
declared Credential that no step references. `Produce with JSONata` and a JSONata request body cannot
read Credentials: the `credentials` root is refused. A secret-like literal in the source is refused
as before.

The compiled Operation lists the declared names in `credentials` (absent when none are declared);
each reference compiles to a `{ "kind": "credential", "credential": "<name>" }` source on the HTTP
header, the PostgreSQL `authentication` or the Shell `variables` entry. At attempt admission TRUST
resolves exactly the declared names from the Environment's Credentials and refuses the attempt when
one is missing, before any external action. A dry-run receives no Credential.

## Step results

Every step result has one stable shape:

```text
Shell     -> exitCode, stdout, stderr
File Text -> relativePath, content
File JSON -> relativePath, content
HTTP      -> status, headers, body
PostgreSQL -> result
```

`Produce with JSONata` sees `input`, `environment`, `steps` and `execution.id`, never Credentials. It must return exactly
the declared fields. The JSONata subset is closed by the compiler.

A field copied from `input` attests the admitted context used by the executed action. It does not
claim that the external system independently re-observed that value. Step-derived fields attest
the action result itself.

## Catalog purpose

The software Operations exercise Git, Jira, Maven, Karate, Playwright, Docker, Kind, Kubernetes and
trace reading. The healthcare, aviation and food Operations call simulated HTTP endpoints. They are
language examples and runner smoke-test inputs, not claims that TRUST contains professional domain
rules. `file.smoke-signal-read` is the deliberately controlled live-smoke Operation: it reads only
`trust-smoke.json` from the Environment root so an external operator can drive both qualification
outcomes without changing runner behavior.

An Operation is reusable. A compiled Procedure embeds the exact compiled Operations it uses, so a
later catalog change cannot silently change an existing Procedure revision.
