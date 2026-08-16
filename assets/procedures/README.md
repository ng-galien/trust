# TRUST Procedure catalog

A Procedure describes a Plan as typed context, Scenarios and Checks. A Check runs one named
Operation, maps Plan context to its Input and qualifies the fields it produces. A Procedure never
repeats the Operation's Input, Environment, execution steps or produced-field contract.

The closed language is specified in [GRAMMAR.md](GRAMMAR.md).

## Current corpus

The catalog deliberately exercises different sizes and domains:

- Git status: one Check;
- mono-project Jira, Git and Maven change;
- integration test with an OpenTelemetry trace marker;
- Playwright user-interface test;
- multi-project Red-Green, Maven, Docker, Kind and Kubernetes deployment;
- simulated hospital patient admission;
- simulated aircraft departure;
- simulated food-batch release.

The last three Procedures test language expressiveness outside software development. Their
Operations use simulated endpoints. The Procedure language itself contains no healthcare,
aviation, food or software-specific keyword.

## Compilation boundary

`compileProcedure` receives one Procedure source and a catalog of compiled Operations. It resolves
every referenced Operation, validates every Input binding and produced-field predicate, then embeds
only the exact Operations used by the Procedure. The compiled revision is autonomous.
