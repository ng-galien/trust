# TRUST V1 — minimal product scope

Status: accepted product scope. This document is normative for V1.

## Product loop

TRUST implements one loop:

1. publish a Feature containing capability contracts and Checks;
2. engage a Plan with its root inputs;
3. give a Skill one semantic Check URI;
4. execute the external action;
5. submit Facts through OTLP;
6. validate the Facts and return `VALIDATED` or `NOT_VALIDATED`.

A Check is `OPEN` or `SATISFIED`. Facts and Snapshots are immutable history. The active
qualification may be replaced by newer accepted Facts.

## Feature

One English Gherkin Feature owns:

- procedure roles;
- capability, effect and replay policy;
- typed inputs;
- typed observations;
- output projections;
- named Checks and predicates;
- Scenario dependencies.

The compiler produces one `actionContractDigest` from the capability and its normalized Action
Contract. The digest contains no fixture, test case or verifier result.

A Feature may compile and be published before a Skill exists.

## Skill

A Skill release declares the exact pairs it implements:

```text
capability · actionContractDigest
```

The SDK exposes the same action through CLI, MCP STDIO and MCP HTTP. An envelope changes transport,
not behavior.

For one admitted Check, the Skill:

1. receives the capability, action inputs and output contract;
2. executes the external action;
3. converts the native result into Facts;
4. submits the Facts through OTLP;
5. finalizes the attempt and returns the action result with the TRUST verdict.

The Skill owns its external permissions, observations and provenance. It never qualifies a Check.

## Fact validation

TRUST accepts a Fact batch only when:

- it matches the admitted execution, capability and Action Contract;
- every observation required by the Check is present;
- no unknown observation is present;
- values, cardinalities and correlations match the contract;
- output projections match the granted output contract.

A rejected batch produces no Fact, Snapshot, verdict or checklist change. The Skill may re-observe
and resubmit. Identical accepted Facts and their resulting state are deduplicated.

Only accepted Facts can change a Check. A grant or an action result is never proof.

## Plan and dependencies

Plan engagement accepts only:

```text
procedure@version · plan identifier · environment · root inputs
```

Fixed roles and future Skill outputs are not repeated. Roles declared by the agent are replaced only
through the closed revision-checked declaration operation.

Delegation is refused until every prerequisite Scenario is validated and every referenced upstream
Check observation has an active `VALIDATED` qualification.

New accepted Facts recompute the current Check and recursively reopen its dependants. Independent
Checks remain unchanged.

## Skill policy

`TRUST_SKILL_POLICY=local` is the default. It admits the requested Skill without registry
credentials or deployment preparation. Capability and Action Contract matching still occur in the
SDK, and TRUST still validates every Fact.

`TRUST_SKILL_POLICY=verified` additionally requires:

- a registered release claiming the exact capability and Action Contract;
- a verified link between the release and installed distribution;
- release authorization;
- deployment authorization;
- environment selection;
- a current deployment announcement and passing probes;
- matching runtime and process identities.

There is no fixture suite, verifier `PASS`, conformance profile or attestation.

## Replay

Without accepted Facts, the Check is unchanged and the Skill may be invoked again. Replayable and
domain-reconcilable actions may run again after an unknown result. A rare non-replayable unknown
result requires human intervention. TRUST does not provide a generic exactly-once engine.

## V1 acceptance threshold

Public-boundary evidence must prove:

1. a Feature compiles and publishes without another catalog or fixture corpus;
2. a Plan engages with only its closed root inputs;
3. a Skill can be invoked with one Check URI;
4. local policy requires no registry preparation;
5. verified policy rejects a missing or incompatible release or deployment;
6. incomplete or invalid Facts are rejected atomically;
7. accepted Facts produce an explicit verdict and checklist delta;
8. identical Facts are deduplicated;
9. dependencies block premature delegation;
10. new accepted Facts can reopen dependent Checks without deleting history.

## Deferred

V1 does not require:

- fixture-based Skill certification;
- schema negotiation;
- multiple contract profiles;
- automatic Skill selection;
- automatic Plan-input discovery;
- generic retries, journals or exactly-once execution;
- high availability or automatic recovery;
- a rich operator interface.
