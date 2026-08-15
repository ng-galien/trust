# TRUST Operation catalog — design direction

## Status

This document records the current design direction for TRUST Operations. It is a guide for the
next iterations. It is not the grammar specification, the compiled contract, or an implementation
plan.

The direction comes from reducing the current Git, Jira and Maven examples to the information that
is actually required to execute them and produce values usable by TRUST.

## Direction

TRUST uses one closed Gherkin DSL with two distinct Feature kinds:

- an **Operation Feature** describes how to produce values;
- a **Procedure Feature** describes what Checks must establish from those values.

An Operation is reusable. A Procedure references an Operation by its stable name and does not
repeat its inputs, produced fields or execution details.

Gherkin is the source language. The runner does not interpret Gherkin. The server compiles Gherkin
into a `CompiledOperation`, hydrates its Input and Environment, and gives that object to the runner.

```text
Operation Feature ──> compiled Operation ─┐
                                         ├──> compiled Procedure revision
Procedure Feature ───────────────────────┘

compiled Operation + Input + Environment ──> runner ──> produced values
```

## Separation

### Operation

An Operation owns:

- its stable name;
- the Input values it requires;
- the Environment keys it requires;
- its ordered steps;
- explicit failure conditions that differ from runner defaults;
- its final `Produce with JSONata` expression;
- the names, types and domains of the fields it produces.

### Procedure

A Procedure owns:

- Plan context;
- Scenarios and their dependencies;
- Checks;
- the mapping from Plan context to Operation Input;
- predicates over fields produced by Operations;
- Check reasons;
- materialization of produced values into Plan context.

The Procedure does not redeclare the Operation contract.

### Operation package, runner and server

The Operation package compiles and validates Operation Gherkin. The server resolves the compiled
Operation and hydrates its Input and Environment. The runner executes its Steps.

The runner and server own these technical concerns:

- environment hydration and secret resolution;
- path containment;
- timeouts and size limits;
- step default failure rules;
- OTLP trace construction and correlation;
- Fact construction from produced values;
- Check qualification and verdicts.

These concerns are not written into every Operation.

## Operation language

The current compiled language is intentionally small. It contains only the forms implemented by
the compiler and represented by `CompiledOperation`.

| Purpose | Closed vocabulary |
| --- | --- |
| Acquire data | `Shell`, `File` read, `HTTP` GET |
| Decode content | `Text`, `JSON` |
| Produce values | `Produce with JSONata` |

### Stable step results

Each step returns one stable shape:

```text
Shell -> exitCode, stdout, stderr
File Text -> relativePath, string content
File JSON -> relativePath, JSON content
HTTP -> status, headers, body
```

Every Shell working directory references an Environment field whose type is `directory`. The
compiler translates that closed type to `type: string` and `format: trust-directory` in the compiled
schema; it does not accept an arbitrary JSON value.

A File path is canonical and relative to a `directory` Environment. Absolute paths, parent segments
and backslashes are rejected by the compiler. The runner must still resolve links and prove that the
resolved file remains inside the Environment directory.

An HTTP URL references an Environment field whose type is `url`. The current HTTP vocabulary is
limited to GET and decodes the response as Text or JSON.

### Default failures

- A non-zero Shell exit code fails the Operation by default.
- A non-success HTTP status fails the Operation by default.
- A response declared as JSON fails the Operation when its body is not valid JSON.

### Produce

One final JSONata expression sees:

- `input`;
- `environment`;
- every named step result.

It returns one object containing the values produced by the Operation. That object is returned as
the action result and used by the runner to construct the Fact.

The current JSONata subset does not include regular-expression functions or literals. Regex support
will be added only with a concrete Operation and fixtures; it will not introduce a separate Produce
language.

## Compilation and composition

Composition happens between parsed and compiled definitions, never by textual inclusion of
Gherkin files.

When a Procedure is compiled, TRUST:

1. resolves every referenced Operation;
2. validates the supplied Input and every referenced produced field;
3. incorporates the exact compiled Operations into the Procedure revision.

The compiled Procedure is therefore autonomous. A later change to an Operation does not silently
change an existing Procedure revision. Runtime execution does not require the runner to query an
Operation registry.

Source autonomy applies to the source package rather than to one Procedure file: the package
contains the Procedure Features and the Operation Features they reference.

## Deliberate limits

- The DSL is closed. Arbitrary natural-language steps are not executable.
- Shell arguments remain structured; the runner does not invoke a shell parser.
- Environment declarations contain typed fields, never secret values.
- Input, Environment and produced fields compile directly to closed JSON Schema objects. Those
  objects are the runtime contract; no parallel hand-maintained schema duplicates them.
- OTLP envelopes, Fact metadata and Check verdicts are generated, not authored in Operations.
- No additional operator is introduced without a concrete Operation that cannot be expressed
  clearly with the existing vocabulary.

## Next operators

XML File decoding, File write and explicit failure conditions remain candidates. They are
not part of the current grammar or `CompiledOperation`. Accepting a non-zero Shell exit is one such
future condition; Maven verification is the reference example. Each addition requires a concrete
Operation and its fixtures.

## Current examples

The catalogue contains executable Git, File and HTTP Operation Features. The neighboring Jira and
Maven text files are exploratory examples used to derive later language additions; they are not
valid Operation Gherkin and are not normative grammar.

The next useful step is to use these compiled Operations from the minimal Procedure. Jira, Maven
and deployment Operations can then expose missing language requirements without designing them in
advance.
