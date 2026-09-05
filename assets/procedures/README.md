# TRUST Procedure catalog

A Procedure describes a Plan as typed context, Scenarios and Checks. A Check runs one named
Operation, maps Plan context to its Input and qualifies the fields it produces. A Procedure never
repeats the Operation's Input, Environment, execution steps or produced-field contract.

The closed language is specified in [GRAMMAR.md](GRAMMAR.md).

## Retained scenarios

- [Dragon Heist](dragon-heist/README.md): the selected tabletop demonstration,
  with a dedicated game extension and reusable nested Procedures.
- [Relay dice game](relay-game/README.md): a short multi-agent game with four
  nested Plan levels, a parallel branch and browser-driven escalation resolution.
  Scenario specification only; executable artifacts are not yet published.

## Current corpus

The catalog deliberately exercises different sizes and domains:

- Git status: one Check;
- mono-project Jira, Git and Maven change;
- integration test with an OpenTelemetry trace marker;
- Playwright user-interface test;
- multi-project Red-Green: one ticket branch cut from clean `main` per project, one Karate red run, one Maven verification and one build-load-rollout per project on Kind, one green run, one trace read, one merge into `main` per project (nine Scenarios, ten Checks);
- simulated hospital patient admission;
- simulated aircraft departure;
- simulated food-batch release;
- controlled runner smoke: one fixed file observation whose external content deliberately drives
  `NOT_VALIDATED` or `VALIDATED` without a project or remote service.

This smoke is deliberately driven interactively by an agent. The operator controls
`trust-smoke.json` outside Check execution; the agent reads the Plan, invokes the packaged runner,
declares escalation when appropriate, waits for an operator to resume, then reads the Plan and
invokes the Check again. The Operation and runner only read the file.

The last three Procedures test language expressiveness outside software development. Their
Operations use simulated endpoints. The Procedure language itself contains no healthcare,
aviation, food or software-specific keyword.

## Compilation boundary

`compileProcedure` receives one Procedure source and catalogs of compiled Operations and exact child
Procedure versions. It resolves referenced dependencies, validates Input bindings and typed Check
qualification, then embeds the used Operation and child definitions. Child Invocations remain
separate from Checks. Runtime compilation supplies only published child versions; the foundation
limits and Invocation syntax are specified in [GRAMMAR.md](GRAMMAR.md).
