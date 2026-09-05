# Canonical contracts and exhaustive consumption

Status: canonical contract cleanup implemented; targeted public acceptances passed.

## Confirmed incident

The Operation overview for `coordination.mission-create` threw while reading
`file.relativePath` from a PostgreSQL step. The runtime's compiled Operation was
valid. The UI had a handwritten `OperationStep` union omitting PostgreSQL, an
open property index, and assertions which treated the last branch as a file.
React had no error boundary around the resource outlet, so the render error
unmounted the application instead of leaving navigation available.

This is not a failure of the TRUST DSL compiler. TypeScript checked the UI
against its incorrect local declaration. JSON-RPC response assertions did not
compare that declaration with the actual server contract.

## Authority map

| Contract | Canonical owner | Consumer rule |
| --- | --- | --- |
| Compiled Operation and closed step union | `trust-operation/src/operation.ts` | Import the canonical type; use its total visitor |
| Compiled Procedure, Checks and child invocations | `trust-procedure/src/procedure.ts` | Import canonical types, including readonly collections |
| Plan internal state and persistence | `trust-runtime/src/model.ts` | Keep internal state distinct from public read models; shared public Fact shapes come from the SDK |
| Public Plan/Check/history views | `trust-extension-sdk` (extracted from runtime readers) | Server and consumers import the same public types |
| Admission, engagement and finalization results | `trust-extension-sdk` (extracted from runtime services) | Reuse the actual public service result types |
| Language-server models | Canonical Operation/Procedure imports | LSP-specific protocol structures are legitimate adapters, not new domain definitions |

## Required guarantees

- A total visitor belongs beside each canonical union which needs variant dispatch.
  Adding a variant requires every total handler record to address it.
- The only correlation assertion belongs inside the visitor implementation, not
  in consumers. No fallback silently treats an unknown variant as a known one.
- UI presentation state and intentional capability projections may remain local;
  projections derive from the canonical type with `Pick` or indexed access.
- A standalone SDK must not load runtime implementation into the browser or give
  an extension access to runtime internals. Extension compilation must work against
  its exported declarations without recompiling the server.
- Static type sharing is not runtime JSON validation. Existing canonical
  validators should be reused where available; do not duplicate their schemas.
- Resource rendering failures must preserve shell navigation and present an
  explicit display error, never an execution verdict.

## Verification

Only public acceptance tests are behavioral evidence. Typechecks demonstrate
static consistency, not that browser journeys or execution work. Verify all
four Operation variants, PostgreSQL overview and simulation, source navigation,
version selection, runtime/runner execution, and browser error containment.

No database reset, commit, or publication is part of this cleanup.

## Verified scope and evidence

- UI contract file now consists of canonical exports and derived aliases, not
  independent Operation, Procedure, Plan, Check, Fact, Trial or Environment shapes.
- Runner admission/finalization/continuation types share the SDK definitions.
- Both extensions use SDK Plan summary/detail, lifecycle and page contracts.
- LSP already consumed canonical language models; no duplicate compiled model
  definitions were found in its adapter. Protocol-specific LSP structures remain.
- Operation visitors cover steps, Shell arguments, HTTP value sources, path
  segments, bodies and formats. Procedure role sources have their own visitor.
- All-workspace TypeScript verification passed.
- Browser acceptance passed four scenarios together: all four step variants,
  PostgreSQL overview/expanded SQL/simulation, version authoring, render isolation.
- Real-runtime and packaged-runner tests passed five HTTP/Shell/game scenarios
  plus a PostgreSQL persistence and repeat-claim scenario.
- Runtime public tests passed extension lifecycle/grants/events and nested Plans
  at three and four levels, including independent intentions and restart.
- Packaged SDK declarations compile an isolated extension with no runtime
  installed. This proves standalone type consumption, not registry publication.

## Explicit limits

JSON response assertions remain a separate runtime-validation concern; sharing
types does not validate arbitrary network payloads. UI form JSON Schema models
and graph/presentation state are not copies of domain contracts. Compiler parsed
grammar unions are distinct from compiled Operation steps. In the controlled
canonical consumer scopes, discriminant predicates also use exhaustive matchers.
Unrelated value guards and data transport are not variant dispatch.
Code Moniker guards known contract declarations and architectural
dependencies, not every possible renamed structural duplicate.

## Structural enforcement follow-up

Code Moniker 0.11.0 is installed. Its documented AST domain recognizes source
constructions, not inferred TypeScript unions or control-flow exhaustiveness.
The enforcement therefore has two complementary responsibilities:

- TypeScript checks the complete handler records against the canonical union.
- Code Moniker rejects documented bypass constructions within explicitly
  selected consumer scopes. Public CLI acceptance must demonstrate both actual
  violations and accepted controls; rule reports must show nonzero selection.

A passing syntactic gate must not be presented as proof that every possible
consumer or renamed type has been identified. Switches, conditional dispatch,
assertions, and indirect dispatch need separate coverage statements. Simple
transport does not require a matcher; canonical discriminant filtering within
the controlled scopes does.

The implemented matchers also cover file formats, Operation value types and
Procedure expression references. Diagnostic event handling is a separate family
and must not be counted as covered by an Operation-step rule. Structural rules
and their public CLI acceptance are implemented and verified. See
`docs/architecture/rule-curation.md` for the policy, explicit coverage limits,
and nonempty rule reports. Runtime implementation re-exports and the UI contract
barrel have been removed; consumers import the owning public package directly.

## Next: pure re-export shim review

After canonical contract enforcement is validated, investigate Code Moniker
rules for modules whose only responsibility is forwarding exports. Do not
expand the current cleanup into a repository-wide deletion campaign.

- Detect the structural fact using documented AST, symbol, and reference
  capabilities; imports, local declarations, and executable side effects must
  be distinguished from pure forwarding.
- Separate detection from architectural legitimacy. Declared public package
  facades are valid even when they contain only re-exports.
- Flag internal forwarding modules without a declared boundary for review;
  document whether each is intentional or an unfinished-refactor relay.
- Verify the detector through public CLI acceptance with legitimate facades,
  unnecessary internal relays, and non-relay controls. Record coverage limits.
- Remove confirmed unnecessary relays only after tracing and updating their
  consumers. Preserve public entry points unless their change is explicitly
  included in the approved cleanup.
