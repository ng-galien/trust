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
  (`openWorkOrderCount equals 0`, `openDeviationCount equals 0`,
  `registeredSource is in context "energy source"`);
- `before`/`after` on materialized instants prove the regulatory ordering, not just the states.

| Procedure | Domain | Agent role |
| --- | --- | --- |
| `10-aircraft-release-to-service` | Part-145 maintenance release | Maintenance-records agent: reconciles work package, part traceability and certificates, assembles the release dossier |
| `11-sterile-batch-certification` | GMP Annex 16 batch release | Batch-record review agent: reads the executed record, drives deviations to closure, prepares the QP certification dossier |
| `12-hv-work-permit` | Lockout-tagout on HV installation | Work-preparation agent: derives the isolation scheme from the installation diagram, sequences isolation, permit, work, de-isolation |
| `13-flight-checklist-conformance` | FOQA/FDM post-flight analysis | Flight-data analyst agent: digs into the QAR telemetry to prove each required checklist was actually performed, investigates and files what it cannot evidence |

## DSL gaps these cases hit

Written in the sources as if they existed, marked with `# DSL GAP` comments:

1. **`differs from`** — independence of persons (four-eyes). Aviation duplicate inspection:
   the inspector must be a different person from the mechanic. Same need for the zero-energy
   verifier vs the lock applier, and QP vs production. No inequality relation exists.
2. **`at most`** — upper bound on a number. Cold-chain temperature must stay at most 8. Only
   `at least` exists.
3. **`after every`** — one instant compared against a many-instant role. The release
   certificate signs after every work-order closure; the QP certifies after every test result;
   the permit issues after every zero-energy verification. `after` today compares one-to-one.
4. **Alternative satisfaction** — a per-item disjunction. Flight conformance requires, per
   checklist, "matched telemetry signature OR recorded finding"; Checks only conjoin, so the
   disjunction must be computed by an external assessment system and observed as one count.
   Expressing it would need an "either Check A or Check B" form.

Everything else these regulated processes require is already expressible.
