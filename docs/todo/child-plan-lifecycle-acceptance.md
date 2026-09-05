# Child Plan lifecycle acceptance checklist

Review baseline: 2026-09-05, during implementation. The checklist records required
public evidence; the execution record below identifies cases actually run. The selected contracts are in
[Child Plan composition](child-plan-composition.md). It supplements that document's
coverage matrix without changing compiler, runtime or test implementation.

Use test-owned storage and real RPC/MCP, Runner and OTLP boundaries. For admission
refusals, an external action counter must remain unchanged. For races, control the
external action or response boundary; concurrent requests and sleeps alone cannot
establish which transition won.

## Required journeys

1. **Three and four levels with intermediate final Checks.** Execute both
   `R → A → B` and `R → A → B → C`. Give R, A and B explicit final Checks after their
   invocations, and add an unrelated sibling beside B. Completing C permits B's
   final Check but does not complete B, A or R. Finish bottom-up and inspect the
   current child relation, checklist, intent, Session and owning Procedure source
   at each level. The unrelated sibling retains its identity throughout.

2. **Invocation-only parent and delayed activation.** Include an intermediate
   Procedure with zero local Checks and one required invocation. It remains
   incomplete until its current child completes. A downstream Scenario containing
   a Check becomes admissible when this invocation-only prerequisite completes.
   Also exercise an invocation whose Input is materialized by an earlier Check:
   no child action before that Input and all prerequisites are ready. Parent
   discovery through MCP must work even when the parent has no local Check URI.

3. **Intent and declaration isolation.** Invoke the same child twice with the same
   local role and Check names. Start both intent chains and interleave attempts;
   advancing A must not bind, release or rotate B's intent or the root's. Reject a
   stale intent and a stale declaration revision without modifying another Plan.
   Reading the parent must not reset any child's already-started chain. Reopening
   a child's Session preserves the current child and its intent. These are Plan
   scope guarantees, not a claim that intent text authenticates an agent identity.

4. **Child-local requalification through four levels.** Complete the tree, then
   reobserve C through the dry-run public path with accepted changed Facts. C
   remains the same child instance. Its affected local Checks reopen, and B, A,
   R lose every qualification dependent on that child's readiness. A direct parent
   read and direct final admission must see this withdrawal without first reading
   intermediate Plans. Independent sibling generations and qualifications remain.
   Do not invent live re-observation of an already satisfied Check for this case.

5. **Parent invalidation replaces only the affected subtree.** Change the parent
   dependency or Input signature before its child starts, while its leaf action
   is pending, and after completion. Remove and later restore the same Input value
   as a separate case: restoring an old signature must not resurrect a superseded
   child identity. The next eligible invocation receives one fresh generation;
   every old descendant remains readable and ineligible for new admission.

6. **Late old descendant and attempt-key replay.** Hold C's external action after
   admission, replace A from R, then let C report Facts and finalize. Retain the
   already-admitted observation as history under the selected contract; it cannot
   satisfy the replacement A or any current ancestor. Try a new attempt key, the
   old pending key and a duplicate finalized response on the old leaf. None may
   admit new old-generation work or restore readiness. Try re-engaging and
   reopening an old Plan: a fresh Session must not bypass supersession.

7. **Ancestor escalation versus Session closure.** With C actionable, escalate R
   after an eligible negative Check: new C admission is refused despite C having
   an open Session. Resume R explicitly and admit C without replacing C or
   restarting its intent. In a separate run, close or expire R's Session without
   escalation: C remains independently admissible. Closing C's own Session blocks
   C admission but does not invalidate historical qualification or stop its
   siblings. An already-admitted external action is never treated as rolled back.

8. **Leaf escalation and sibling independence.** Escalate C after a finalized
   `NOT_VALIDATED` attempt. B's final and transitive dependent final Checks remain
   blocked, while an unrelated sibling of B can continue. R and A must not acquire
   fabricated active escalation records. A parent whose local Checks are all
   satisfied but whose child is escalated remains incomplete with an explained
   child blocker. Explicitly resuming C must not resume an independently escalated
   ancestor.

9. **Final parent admission against replacement.** Order replacement before final
   admission and verify refusal with zero external actions. Reverse the order:
   admit and hold the final external action, replace the child generation, then
   release Facts/finalization. The external action may have occurred, but the final
   result must not leave current parent qualification satisfied against an obsolete
   dependency. Repeat at A and R in the four-level tree. A cached continuation or
   cached `completesPlan` projection cannot authorize admission by itself.

10. **Completion and ancestor escalation races.** Race leaf completion with child
    replacement, and descendant admission with ancestor escalation. In each case
    assert outcomes consistent with one committed ordering. A superseded child
    never becomes current again; a descendant is not newly admitted after its
    ancestor's escalation commits. Also retry the same completion response after
    the race to detect duplicate propagation or extra generations.

11. **Restart at durable transition boundaries.** Restart after child activation
    commits but before its response is delivered; after an external action finishes
    but before Facts arrive; after Facts commit but before finalization; and after
    child completion commits but before parent notification. Preserve identities,
    accepted Facts, current generations and independent intent reservations. Resume
    finalization after accepted Facts without replaying the known external action.
    Concurrent activation/retry after restart yields exactly one current child.
    No recovery may rely solely on an in-memory event callback.

12. **Public projection and reconnect.** Compare direct root/child RPC, MCP and
    Runner continuation after each withdrawal, replacement and escalation. Every
    executable URI belongs to a leaf Check in its actual child Plan; Procedure
    reads return that child's source. Reconnect SSE after a process restart and
    require a resync to recover parent and descendant state. Historical generations
    remain distinguishable from current children; a persisted worker response
    marked completed is insufficient for any invocation qualification.

## Concrete flat-runtime pressure points

Code Moniker's bounded `extract` of `packages/trust-runtime/src/plan/runtime.ts`
confirmed calls into `checkDependenciesSatisfied`, `dependentCheckUris`,
`completesPlanOnValidation` and `buildPlanRevision`. Source inspection of the
flat implementation identified these required integration points:

- `plan/intent.ts`, `plan/read.ts` and both declaration/finalization paths in
  `plan/runtime.ts` derive completion from local Checks and declarations. All
  must account for incomplete invocations, including zero-local-Check Plans.
- `check/actionability.ts` expects prerequisite Scenarios to contain local Checks.
  The same readiness definition must serve reads, admission, finalization and
  retention after invalidation when a Scenario contains invocations instead.
- `dependentCheckUris` traverses only one Plan's Check and Scenario edges.
  Descendant invalidation therefore requires authoritative cross-Plan propagation;
  merely decorating a read view is insufficient for direct final admission.
- Admission resolves before its transaction; `#createAttempt` checks the local
  revision. Generation and ancestor-escalation eligibility must be checked inside
  the committed admission boundary, and current dependency readiness rechecked at
  finalization. Checks on only the direct parent miss superseded ancestors.
- `#ingest` checks the admitted historical Check and local Session/intent, while
  `#finalize` checks local currentness. Preserve the selected distinction between
  accepting historical in-flight Facts and activating current qualification.
- `close` changes a Session; `engage` can reopen it. Neither Session state nor an
  automatically reopened Session can stand in for durable generation eligibility.
- `PlanEvents` is explicitly process-local. Completion propagation cannot depend
  exclusively on events; durable state must recover through restart and reread.
- MCP Plan reads currently start from a Check URI. Invocation-only ancestors need
  an actual supported discovery/read path, not a fabricated executable Check.

The current compiler acceptance covers nested immutable definitions and binding
rejections. Compiling nested definitions does not execute nested Plans, establish
these lifecycle transitions, or prove race/restart behavior. Implementation is
changing concurrently: these are coverage obligations, not a verdict on a later
completed runtime revision.

## Executed cascade acceptance evidence

On 2026-09-05, `child-plan-cascade.acceptance.test.ts` ran against isolated real
runtime processes and test-owned SQLite databases: **4 tests passed, 0 failed,
0 skipped**. The command was:

```sh
npm run build --workspace=@trust/runtime
node --test --test-concurrency=1 packages/trust-runtime/dist/acceptance/child-plan-cascade.acceptance.test.js
```

- Case 4: both positive-to-positive and positive-to-negative leaf requalification
  through four levels. Direct root admission checks the actual dependency refusal
  before any ancestor read; root and intermediate qualifications reopen, the same
  child identities remain, and an unrelated sibling's entire view stays unchanged.
- Cases 5 and 6: replace the root's child Input while a great-grandchild attempt
  is admitted and its operator Facts are withheld. Late accepted Facts and
  historical finalization remain on the old leaf; all replacement views and
  intentions stay unchanged. Direct old leaf admission reports supersession, and
  duplicate historical finalization cannot advance the replacement root.
- Case 11, accepted-Facts-before-finalization boundary: restart the real process
  with the same test-owned database, then finalize the same attempt without another
  admission or observation. Identical Fact IDs, one attempt, independent intentions
  and current child relations survive; the immediate parent still needs its own
  final Check.

These executions use the authorized dry-run operator RPC path. They do not prove
live Runner/OTLP delivery or abrupt process termination: the tested restart is
orderly after the Facts RPC response. The remaining checklist cases require their
own execution evidence; this record does not mark the entire matrix covered.
