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
invalidation, still needs an explicit contract.

Closing or superseding a child cannot undo an external action already admitted.
Specify admission blocking, treatment of in-flight attempts, and reconciliation
before implementing lifecycle propagation. Do not promise process cancellation or
rollback of external side effects merely because a Plan relation changed.

## Design work before implementation

1. Define stable parent/invocation/generation identity and atomic creation so
   repeated reads or concurrent requests cannot create duplicate active children.
2. Define instantiation timing: initial engagement versus activation after bound
   inputs and prerequisites become available. Do not start child actions before
   the parent dependencies permit them.
3. Resolve exact child versions and typed Input/Result contracts at compilation;
   reject cycles and ambiguous bindings. Runtime child identity is not a substitute
   for an immutable compiled Procedure dependency.
4. Define how the parent observes authoritative child completion, which exact
   generation it qualifies, and how invalidation withdraws that dependency.
5. Define escalation, Session expiry, parent closure and child replacement
   propagation without unnecessarily stopping unrelated siblings.
6. Define independent declaration ownership and concurrency, and whether an
   invocation's result can cross into parent context before full child completion.
7. Specify RPC/MCP reads, semantic Check addressing, history and UI grouping.
8. Validate real public acceptance journeys: independent child intentions,
   dependency refusal, final parent validation, restart without duplication,
   replacement after invalidation, late old-child response, and escalation.

This direction reuses Plan lifecycle services but is not a small parser change.
No new child-plan API, schema or runtime behavior is implemented by this document.
