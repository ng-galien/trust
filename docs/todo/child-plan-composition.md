# Child Plan composition

Status: product direction selected; detailed contracts and implementation pending.

This supersedes the single-Plan execution model in
[Procedure composition](procedure-composition.md). The current executable runtime
does not yet implement either composition model. Existing independent delegation
Plans must not be retrospectively described as children of a parent Plan.

## Selected direction

- A composed Procedure invocation instantiates an explicit child Plan linked to
  its parent Plan and invocation identity.
- Each child has its own Checks, intention chain, Sessions and history. An
  intention chain starts once for that execution; resuming the same instance does
  not reset it.
- The parent governs dependencies between invocations and its final validation.
  A worker's declared completed response is not a child's TRUST completion.
- Children remain individually visible and are also presented in their parent
  context. Separate child execution, invocation and parent completion in the UI.
- The parent's Environment is the default. A possible explicit override was
  discussed, but its authoring, authorization and validation are not yet defined;
  do not silently introduce cross-Environment execution in the first slice.
- When invalidation requires an invocation to execute again, create a new child
  instance. Do not recycle the prior child's identity or overwrite its history.

## Lifecycle distinctions to preserve

Resuming an interrupted attempt in the current child is different from executing
a new generation of the parent invocation. Normal Runner retry behavior remains
applicable; replacement must not turn every transport interruption into a new
child or repeat a known external action.

The parent must identify one current child generation for each invocation. A
superseded child's late response cannot satisfy the replacement generation.
Historical children remain readable. The precise event that replaces a child,
including how child-local requalification differs from parent invocation
invalidation, follows these selected rules:

- A changed parent invocation dependency or Input signature invalidates that
  invocation and replaces its child generation when it becomes eligible again.
  Every superseded descendant remains historical; unrelated sibling branches
  retain their current child identities.
- Child-local requalification withdraws authoritative readiness from dependent
  parent invocations and Checks, recursively through ancestors. It does not by
  itself replace the child being requalified. Ordinary retry and Session reopening
  also retain that child's identity and current intention chain.
- A superseded subtree cannot admit new attempts. Facts from already-admitted
  attempts remain history and cannot qualify the replacement generation or make
  its current ancestors complete. Existing Fact schema, Attempt correlation,
  expiry and own-Session checks still apply; supersession alone must not discard
  an otherwise admissible in-flight observation. The current-generation relation must be checked
  at admission and qualification, including when replaying an existing attempt
  key or finalization response.
- An explicit active escalation in any ancestor blocks new descendant admission.
  Closing or expiring an ancestor's Session alone does not: child Sessions are
  independent. A child escalation blocks work that depends on it; it does not
  create an escalation on its parent or stop unrelated siblings.

Closing or superseding a child cannot undo an external action already admitted.
Admission blocking does not cancel an already-admitted external action. Preserve
the distinction between retained history and current qualification when an action
finishes after supersession or ancestor escalation. Do not promise process
cancellation or rollback of external side effects merely because a Plan relation
changed.

## Design work before implementation

1. Define stable parent/invocation/generation identity and atomic creation so
   repeated reads or concurrent requests cannot create duplicate active children.
2. Define instantiation timing: initial engagement versus activation after bound
   inputs and prerequisites become available. Do not start child actions before
   the parent dependencies permit them.
3. Resolve exact child versions and typed Input/Result contracts at compilation;
   reject cycles and ambiguous bindings. Runtime child identity is not a substitute
   for an immutable compiled Procedure dependency.
4. Implement authoritative child completion for the exact current generation,
   including transitive withdrawal and atomic parent admission against replacement.
5. Implement the selected escalation, independent Session and child replacement
   rules without unnecessarily stopping unrelated siblings.
6. Define independent declaration ownership and concurrency, and whether an
   invocation's result can cross into parent context before full child completion.
7. Specify RPC/MCP reads, semantic Check addressing, history and UI grouping.
8. Validate real public acceptance journeys: independent child intentions,
   dependency refusal, final parent validation, restart without duplication,
   replacement after invalidation, late old-child response, and escalation.

This direction reuses Plan lifecycle services but is not a small parser change.
No new child-plan API, schema or runtime behavior is implemented by this document.

## Acceptance coverage is a delivery gate

The product owner requires comprehensive execution-scenario coverage. The initial
two-worker happy path is an integration probe, not sufficient release evidence.
Required nesting includes both a three-level chain and a four-level chain
(root → child → grandchild → great-grandchild), not just several sibling
invocations. Combine depth with siblings to prove that invalidating one branch
does not replace unrelated branches. Finite nesting and cyclic Procedure
dependencies are different cases: support the former and reject the latter.
Before implementation, turn each selected lifecycle contract into explicit public
acceptance cases with preconditions, action, expected state, forbidden effects and
observable evidence. Unresolved semantics block the affected implementation slice;
tests must not silently choose product behavior.

| Area | Required cases |
| --- | --- |
| Compilation | Exact child versions; unknown child; cycles; missing/extra/ill-typed bindings; cardinalities; duplicate invocation names; same child invoked twice without identity collision; immutable published dependency |
| Instantiation | Eligible invocation; prerequisites not yet satisfied; delayed inputs; repeated engagement/read; concurrent activation; crash around creation; exactly one current generation per invocation |
| Independent execution | Two agents interleaved; independent intentions and Sessions; stale intent refusal; one child unable to consume another child's declaration or invocation context; parent remains incomplete while a required child is incomplete |
| Deep composition | Three and four nested levels; siblings at an intermediate level; bottom-up completion; an intermediate final Check still required after descendants complete; leaf escalation; ancestor invalidation replacing only the affected subtree; late superseded descendant results; process restart preserving all current relations and independent intention chains |
| Dependency admission | Child or parent Check refused before prerequisites; admission after authoritative qualification; external completed response insufficient; no external action on refusal; final parent Check gated by all required invocations |
| Facts and qualification | Complete Fact schema; missing observations rejected atomically; duplicate accepted submissions; negative qualification; transport interruption; no advancement inferred from action output or exit status |
| Resume | Runtime restart at meaningful lifecycle boundaries; Session expiry and reopening; retry after interrupted attempt; unchanged current child identity on ordinary resume; no unintended replay of known external actions |
| Replacement | Invalidation before child starts, during an attempt and after completion; fresh generation when replay required; previous history retained; unrelated siblings preserved; withdrawal of dependent parent qualification and Results |
| Races | Concurrent activation; completion versus invalidation; final parent admission versus child replacement; late Facts/response from an old generation; duplicate replacement request; stale revision/declaration update |
| Escalation and closure | Child escalation; parent escalation; explicit resume; parent Session closure; child Session closure; documented sibling behavior; treatment of already-admitted external actions without pretending cancellation undoes them |
| Completion | All required children complete but parent final Check still open; final validation; negative final Check; invalidation after prior completion under the selected live/dry-run contract; obsolete child unable to complete the parent |
| Modes and environment | Inherited Environment; no secret leakage; unauthorized override refused; live Runner/OTLP path; dry-run operator Fact path; explicit handling of modes or combinations excluded from the first slice |
| Public visibility | Matching RPC/MCP state and reasons; exact child Check URI and source ownership; current versus historical generations; event disconnect/reconnect and resynchronization; UI never infers terminal state from a declared response |

All behavioral tests must exercise real public boundaries: compiler/publishing,
RPC, MCP, Runner CLI, OTLP and the built interface as appropriate. Use isolated
runtime processes and test-owned storage. Do not add unit tests or pollute the
shared dogfooding database.

For concurrency tests, control the ordering at public or external action boundaries
and assert both allowed outcomes and forbidden side effects. Sleeps alone do not
prove a race is covered. Fault injection must identify the interrupted boundary and
verify recovery after restarting the real process.

Each implementation slice must report which cases actually ran, their outcomes,
and any skipped or unsupported cases. Keep regression coverage for flat Plans and
the existing delegation procedure. A build, typecheck or coverage percentage is
not a substitute for these execution contracts. Do not claim exhaustive coverage
while lifecycle choices or documented cases remain unresolved.

The focused [lifecycle acceptance checklist](child-plan-lifecycle-acceptance.md)
records concrete execution orderings and the flat-runtime boundaries that need
revalidation as composition is implemented.
