# ADR 0004 — First complete product slice

Status: accepted V1 full-Plan integration slice.

## Functional boundary

| Input | Value |
|---|---|
| Procedure | `defect-correction@3.0.0` |
| Procedure language | `@trust-dsl:1` autonomous Gherkin |
| Root Plan inputs | one `jira issue` |
| Product source | one autonomous Gherkin Feature |
| External orchestration | one agent |
| Skill releases | Jira, Git, Maven, Docker, Kind and Kubernetes |
| Exact capability contracts | 10 |
| Check templates | 12 |
| Instantiated Checks in the canonical two-criterion run | 14 |
| Skill execution | direct source scripts under Bun |
| TRUST transport | MCP reads/engagement, RPC governance/admission/finalization, OTLP Facts |

The Feature declares every role, capability contract, named Check, binding, output
projection, predicate and reason. Every Check uses one Skill capability. Publication accepts that
Feature alone. No startup catalog, adjacent suite JSON or capability-to-suite map participates.

## Operational sequence

```mermaid
sequenceDiagram
    actor A as Agent
    participant T as TRUST runtime
    participant S as Autonomous Bun Skill
    participant E as External system

    A->>T: Engage defect-correction(jira issue)
    T-->>A: Revision 1 + two initial Checks
    A->>T: Replace Feature-owned Plan declarations at revision 1
    Note over A,T: Projects, planned modifications and test/criterion names discovered by the agent
    T-->>A: Revision 2 + checklist materialized from current declarations
    loop Until no open Check remains
        A->>T: Read Plan and actionable Checks
        T-->>A: Checklist + required capability
        Note over A: Write and commit the test or fix before its Git comparison Check
        A->>S: bun packages/trust-runner/scripts/run.ts URI
        S->>T: Announce, probe and request admission
        alt admitted
            T-->>S: exact capability inputs and output contract
            S->>E: Act and observe
            E-->>S: External result
            S->>T: Facts via OTLP
            S->>T: Finalize
            T-->>S: VALIDATED or NOT_VALIDATED + delta
        else refused
            T-->>S: reason; Check unchanged
        end
        S-->>A: External result and TRUST verdict
    end
    A->>T: Read final Plan
    T-->>A: all materialized Checks satisfied, including one confirmation per criterion
```

## Agent-owned work

TRUST proves observations about committed revisions; it does not write the correction. The agent:

1. reads the Jira entry point without deriving work topology from it;
2. investigates and replaces the closed current Plan declarations for affected projects and planned
   modifications;
3. writes the ticket-specific acceptance tests, declares their canonical Scenario names in the
   Plan, and commits them;
4. uses `git.head-compare` to prove that test commit is clean and ahead of its baseline;
5. runs one `maven.defect-reproduce` Check per declared criterion and obtains the expected RED;
6. diagnoses, fixes, locally tests and commits the code;
7. uses `git.head-compare` to prove each clean fix commit is ahead of its code baseline;
8. lets the remaining Maven, Docker, Kind, Kubernetes and one-per-criterion confirmation Checks
   prove the delivery.

The agent may use ordinary Git, Maven, Docker or Kubernetes tools freely for its work. The TRUST
Skills are the governed proof-producing counterparts used only when a Check requires them.

## Resumption, not a sequence machine

New accepted Facts for an upstream Check replace that Check's active qualification and recursively
open every dependent Check through Scenario prerequisites and Check-observation references.
Independent Checks remain satisfied. The same Plan is then resumed from the open actionable
frontier.

The public full-Plan acceptance proves two such resumptions:

- replacing the fix commit keeps the Git comparison satisfied, reopens seven downstream Checks in
  the canonical two-criterion run, then completes the same Plan at revision 24;
- changing the verified Maven artifact while keeping the same Git revision and image tag reopens
  five Docker/Kind/Kubernetes/confirmation Checks, proves exact image provenance and completes at
  revision 30.

An accepted declaration replacement authoritatively replaces the current criterion collection. If
a criterion disappears, its current `on each` reproduction and confirmation Checks disappear with
it. Their immutable history is retained and the same semantic URIs return `OPEN` if the criterion
is declared again. A declaration is never inferred from a Skill result. Independently, a
`NOT_VALIDATED` Skill attempt or an attempt without accepted Facts does not remove any output-backed
role or Check.

## Required public evidence

The slice is accepted only when public-boundary tests prove:

1. dynamic Feature publication and immediate engagement without restart or bootstrap procedure data;
2. six source releases cover exactly ten compiler-owned requirements;
3. six claims, six verified distributions, twelve authorizations and ten selections are recorded,
   while initial preflight remains `NOT_OPERABLE` only for missing announcements;
4. the agent loop invokes only the six public Bun Skill CLIs with a Check URI;
5. admission precedes every external action and Facts enter through OTLP;
6. the canonical two-criterion run reaches revision 16 with 14 satisfied Checks and invokes
   `maven.fix-confirm` once per declared criterion;
7. declaration replacement removes omitted Checks only from the current view, preserves their
   history and reopens the same URIs when the values are declared again;
8. upstream re-observation recursively reopens only dependent Checks and the same Plan resumes;
9. Maven artifact identity, Docker image provenance, Kind node image and Kubernetes rollout state are
    reobserved exactly;
10. no Skill server, wrapper, static business catalog, compiled Skill distribution or local execution
    journal participates.
