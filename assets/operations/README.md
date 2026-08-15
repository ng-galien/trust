# TRUST Operation catalog

An Operation describes how to call one external system and which typed fields that call produces.
It does not define a Check, a Plan, qualification or an OpenTelemetry envelope.

Every `.feature` in this directory is executable source for `@trust/operation`. The compiler emits
one `CompiledOperation`; the runner executes only that compiled object.

## Closed language

An Operation contains:

- one stable `@operation:<domain>.<action>` name and semantic version;
- typed `Input` supplied by the Procedure Check;
- typed `Environment` supplied by execution configuration;
- ordered Shell, File-read or HTTP-GET steps;
- one final JSONata expression;
- the exact typed fields produced by that expression.

The current value types are `string`, `number`, `instant` and `reference`. Cardinality is `one` or
`many`. Environment values are `directory` or `url`.

Shell arguments are structured. Each row is either `literal` or comes from one scalar Input. The
runner never parses a shell command line. Exit code `0` is expected by default. An Operation may
declare other expected exits and may require exact text to occur in their standard output or error
output. An expected exit remains a step result and can produce fields. Any other exit interrupts
the Operation before fields are produced. This distinction lets a failing test be an expected
observation without mistaking a compilation or infrastructure error for that observation.

HTTP GET can use an Environment URL directly or append one scalar Input as one encoded path
segment. HTTP POST sends the complete typed Input as one JSON object and reads one JSON response.
There is no authored header, body template or free URL interpolation. File read accepts one fixed
relative path below a directory Environment.

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
