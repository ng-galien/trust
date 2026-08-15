# ADR 0002 — Source Skill execution and implicit Session

Status: accepted.

## Decision

An agent gives a Skill one semantic Check URI. The mandatory execution envelope is a short-lived
TypeScript source script run directly by Bun. TRUST admits the attempt before the external action,
accepts authentic Facts, qualifies the Check and returns the external result followed by an explicit
`VALIDATED` or `NOT_VALIDATED` verdict, reason and checklist delta.

There is no local Skill database, execution journal, generic recovery engine or exactly-once
guarantee. Without accepted Facts there is no qualification and the Check remains unchanged.

## Runtime boundary

```mermaid
sequenceDiagram
    autonumber
    actor A as Agent
    participant T as TRUST runtime
    participant S as Source Skill + SDK (Bun)
    participant E as External system

    A->>T: engage(procedure, version, plan, environment, rootInputs)
    T-->>A: Session + initial Check URI(s)
    Note over T: Skill availability is not an engagement gate
    A->>S: bun scripts/run.ts --check URI
    S->>S: inspect exact Skill and SDK sources
    S->>T: announce CLI + bounded probes
    S->>T: admit(URI, release, deployment, identities)
    alt delegation refused
        T-->>S: REFUSED + reason
        S-->>A: refusal; no external action; no verdict
    else admitted
        T-->>S: capability + input ports + materialization contract
        S->>E: execute and observe
        E-->>S: external result and observations
        S->>T: Facts through OTLP traces
        T->>T: validate, persist, deduplicate and qualify
        S->>T: finalize(execution handle)
        T-->>S: VALIDATED or NOT_VALIDATED + checklist delta
        S-->>A: external result + TRUST verdict
        A->>T: reread Plan and Checks
    end
```

The grant correlates the requested Check, capability, context, release and future Facts. It is not
proof that the external action occurred. The Skill owns external execution, provenance and observed
values; it never qualifies a Check, and `actionOutcome` is never qualification input.

## Facts, replay and resumption

| Event | Result |
|---|---|
| refusal, crash or interruption before accepted Facts | no Fact, Snapshot, verdict or delta |
| missing predicate observation | atomic rejection before persistence |
| complete accepted Facts | immutable Snapshot and `VALIDATED` or `NOT_VALIDATED` |
| identical Facts replayed | deduplicated Facts, Snapshot, verdict and delta |
| new accepted Facts for one Check | replace its active qualification and recursively reopen dependants |

A Check is only `OPEN` or `SATISFIED`. Facts and Snapshots are immutable history; the active
qualification in the current Plan revision is replaceable. The agent can therefore resume the same
Plan from any open Check whose Scenario prerequisites and Check-observation references are
satisfied.

If no Facts were accepted, replay is normal. The SDK may reobserve and resubmit an incomplete batch
inside the same live roundtrip without repeating a known action. A replayable or domain-reconcilable
action can be invoked again after an unknown result. A rare non-replayable unknown result requires
explicit human intervention rather than a generic recovery subsystem.

## Release compatibility and deployment

The autonomous Feature owns each capability contract. A Skill release manifest claims only exact
`(capability, actionContractDigest)` tuples.

```text
Feature publication
→ exact capability requirement
→ source release claim
→ verified source distribution
→ release and deployment authorization
→ environment selection
→ ephemeral CLI announcement and probes
→ attempt admission
```

`READY` is a dated projection, not a persisted lifecycle state. A procedure can be published and a
Plan engaged while no Skill is available. Admission still requires the exact selected, approved,
compatible and currently announced deployment before any external action.

## Envelopes

| Envelope | Contract |
|---|---|
| CLI | mandatory source entrypoint; one short-lived process per Check invocation |
| MCP STDIO | optional declared managed envelope |
| MCP HTTP | optional declared managed envelope |

All envelopes use the same release, capability handlers, observations and Facts. They change only
transport and process supervision.

## V1 test environment releases

| Source Skill | Exact capability claims |
|---|---|
| Jira | `jira.issue-read` |
| Git | `git.head-read`, `git.head-compare`, `git.worktree-inspect` |
| Maven | `maven.defect-reproduce`, `maven.fix-confirm`, `maven.project-verify` |
| Docker | `docker.image-build` |
| Kind | `kind.image-load` |
| Kubernetes | `kubernetes.rollout` |

These six releases implement ten contracts compiled from the Feature. No static server catalog or
monolithic Skill defines them.
