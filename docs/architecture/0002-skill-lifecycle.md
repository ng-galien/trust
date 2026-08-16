# ADR 0002 — TRUST Skill execution

Status: accepted.

## Decision

An agent gives the packaged TRUST Skill one semantic Check URI. The Skill asks TRUST for admission
before the external action. TRUST returns the compiled Operation, its Input and the selected
Environment. The Skill executes the Operation, emits Facts through OTLP and finalizes the Attempt.
TRUST alone returns `VALIDATED` or `NOT_VALIDATED` and the checklist delta.

The packaged artifact runs with Node and exposes the same runner through CLI and MCP STDIO. These
entrypoints change transport only. They do not change the Operation, Facts or verdict.

## Local policy

`local` is the default policy and the path implemented by the current packaged runner.

```mermaid
sequenceDiagram
    actor A as Agent
    participant S as Packaged TRUST Skill
    participant T as TRUST runtime
    participant E as External system

    A->>S: run one Check URI
    S->>T: check.attempt.admit(Check URI)
    alt refused
        T-->>S: REFUSED + reason
        S-->>A: refusal; Check unchanged
    else admitted
        T-->>S: Operation + Input + Environment
        S->>E: execute Operation
        E-->>S: external result
        S->>T: Facts through OTLP
        S->>T: check.attempt.finalize
        T-->>S: verdict + reason + checklist delta
        S-->>A: external result + TRUST verdict
    end
```

Local admission skips release credentials, registry publication, deployment authorization,
announcement and probes. It still validates the Check URI, Session, dependencies, current Plan
context and accepted Facts.

## Verified policy

`verified` is an opt-in server policy. It adds the exact Skill release, Action Contract digest,
authorization, deployment selection, announcement and probe checks before the external action.
A verified Skill integration must use `skill.attempt.admit` with those identities.

The current generic packaged runner does not implement that verified client sequence. It must not be
presented as announcing or probing itself. Adding that sequence is a separate integration milestone;
it must reuse the same Operation execution and Fact emission.

## Replay

Without accepted Facts there is no qualification and the Check remains unchanged. Re-observation is
normal. Identical Facts and their resulting Snapshot, verdict and checklist delta are deduplicated.
Rare actions with an unknown non-replayable outcome require explicit human intervention rather than
a generic exactly-once subsystem.
