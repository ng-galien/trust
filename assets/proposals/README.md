# TRUST Procedure proposals

Exploratory Procedures for regulated operational processes. They follow the grammar of
[assets/procedures/GRAMMAR.md](../procedures/GRAMMAR.md) but do **not** compile: each one uses
the language exactly where a real regulatory requirement needs it, including where the language
stops. The referenced Operations do not exist yet; their names describe the system read they
would perform.

## Why these processes

Each Procedure frames an agent working in relative autonomy across external systems. The agent
does work no script can do — dossier analysis, cross-system reconciliation, engineering
derivation — and declares the outcome of that work to the Plan. The Checks then re-read every
fact from the systems of record. The pattern in all three:

- **declared by agent** carries the agent's judgment (which work orders, which deviations,
  which energy sources);
- one Check reads the authoritative inventory and catches under-declaration
  (`fact.openWorkOrderCount === 0`, `fact.openDeviationCount === 0`,
  `context["energy source"].includes(fact.registeredSource)`);
- ordered comparisons on materialized instants prove the regulatory ordering, not just the states.

| Procedure | Domain | Agent role |
| --- | --- | --- |
| `10-aircraft-release-to-service` | Part-145 maintenance release | Maintenance-records agent: reconciles work package, part traceability and certificates, assembles the release dossier |
| `11-sterile-batch-certification` | GMP Annex 16 batch release | Batch-record review agent: reads the executed record, drives deviations to closure, prepares the QP certification dossier |
| `12-hv-work-permit` | Lockout-tagout on HV installation | Work-preparation agent: derives the isolation scheme from the installation diagram, sequences isolation, permit, work, de-isolation |
| `13-flight-checklist-conformance` | FOQA/FDM post-flight analysis | Flight-data analyst agent: digs into the QAR telemetry to prove each required checklist was actually performed, investigates and files what it cannot evidence |

## Expression coverage and remaining Procedure gap

The typed qualification expressions directly cover the comparison gaps these proposals originally
exposed:

- independence of persons uses strict inequality (`fact.inspector !== fact.mechanic`);
- an upper numeric bound uses `fact.peakTemperature <= 8`;
- one instant after a collection uses
  `context["verification time"].every(value => fact.issuedAt > value)`.

One structural Procedure gap remains outside the expression language:

1. **Alternative satisfaction** — a per-item disjunction. Flight conformance requires, per
   checklist, "matched telemetry signature OR recorded finding"; Checks only conjoin, so the
   disjunction must be computed by an external assessment system and observed as one count.
   Expressing it would need an "either Check A or Check B" form.
