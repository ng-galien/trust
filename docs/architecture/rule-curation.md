# Executable architecture: rule curation

The product owner's decisions govern the architecture. Code Moniker records and
checks bounded evidence for those decisions; neither a clean report nor a rule
file changes their meaning. This note explains the canonical-contract policy
approved during the September 2026 cleanup.

## Decisions and placement

| Decision | Executable rule | Placement |
| --- | --- | --- |
| Language and public contracts have a single owner | Canonical UI contract names and canonical re-export boundary | Root: consumers span packages |
| The extension SDK is independent of server implementation | SDK dependency excludes runtime, UI and LSP | Root: cross-package direction |
| Package facades are intentional; consumer relay barrels are not | Canonical re-exports require the declared owner entrypoints | Root: publication boundary |
| Closed variants are consumed through their exhaustive matcher | Matcher subpath and AST construction rules | Root: shared consumption convention |
| Each compiler uses its language grammar through the Gherkin engine | Compiler import and parser call-flow rules | Operation and Procedure fragments |
| LSP completion uses the same grammar authority | Descriptor imports and expectation-engine call-flow | Language-server fragment |

The root is the right location for policies whose consumers cross package
boundaries. Moving them into the UI fragment would falsely make ownership a UI
concern. Existing fragments keep implementation-local wiring close to its owner.
Their effective rule IDs include the fragment namespace; that namespace is not a
view URI. No rules were moved merely to improve advisory counts.

The taxonomy retains `dependency` for access and ownership boundaries and
`call-flow` for prescribed consumption paths. `authority` names the responsibility
for canonical meaning; `operation`, `procedure` and `extension-sdk` identify its
concrete owners. There is no new generic “hygiene” category: these are architectural
decisions, not stylistic preferences. The language-only `authority_source` alias
and public-contract `authority_contract_target` alias intentionally differ.

## Why the policy exists

A UI-local Operation step union omitted PostgreSQL. Its rendering path treated an
unhandled variant as a file step and crashed. That incident revealed two separate
design weaknesses: duplicated contract ownership and non-exhaustive consumption.
The solution is not a PostgreSQL-specific exception. Canonical definitions and
their matchers are shared by every relevant consumer. The SDK separates public
contracts from the server; it does not create another copy of those definitions.

Published package facades expose the owning contract deliberately. Consumer
re-export barrels make future refactors follow an intermediate module instead of
the owner, and are therefore rejected for canonical targets. Legitimate derived
presentation types and unrelated exports remain allowed. A future review of pure
relay modules must distinguish their structural shape from whether their role is
actually unjustified; this policy is not a global ban on re-exports.

## Read and maintain the rules

1. Learn the relevant mechanism with `code-moniker rules learn taxonomy`,
   `fragments`, `refs`, `paths`, or `ast`. The bundled CLI reference describes
   capabilities; it does not substitute for project decisions.
2. Read `code-moniker rules show . --profile canonical-contracts --details` for
   the cross-cutting policy. Use `--component operation`, `--component procedure`
   or `--component language-server` to inspect owner-local rules.
3. Keep the message actionable: which access or construction must change. Keep
   the rationale durable: why that direction or consumption contract exists,
   what it proves, and where its evidence ends.
4. Keep selectors readable through semantic aliases. Register new canonical
   variants/imports in consumer discovery when the API grows; fixed known
   consumers remain guarded even if somebody removes their matcher import.
5. Run `node --test scripts/canonical-dispatch.acceptance.test.mjs`, then the full
   `code-moniker check . --format json --report`. Inspect antecedent counts and
   analysis errors, not just the number of violations. Do not replace the full
   gate with the focused profile.

## Evidence and limits

The public CLI acceptance verifies real TS and TSX construction rejection,
canonical import discovery, renamed imports, local type aliases, re-export
boundaries, sanctioned facades and matcher subpaths. Strings/comments containing
example dispatch, ordinary value guards, and unrelated transport routing are
negative controls. It uses temporary fixture workspaces and the real root rules.

Code Moniker 0.11 supplies local AST nodes and direct references, not the
TypeScript type checker or arbitrary dataflow. Renamed direct imports retain
their original target and are supported; a local re-export is rejected at its
origin rather than assumed to resolve transitively everywhere. Construction
rules guard declared/import-discovered consumers, not every inferred-only
receiver in the repository. Computed keys, renamed asserted variants and unusual
dataflow remain review gaps. Extraction of a property named `source` is not banned
because UI source props contain DSL text, although direct discriminator
comparisons remain guarded.

TypeScript verifies complete handler records. Boundary validation verifies JSON.
The SDK mission definition follows the same `/match` import and semantic-consumer
dispatch policy. The exact `plan/mission-declarations.ts` boundary validates unknown
JSON into that union and is excluded from semantic dispatch checks; it must not
take on execution or resolution responsibilities. Public CLI fixtures verify both
rejection of SDK consumer branches and acceptance of this boundary validation.
The `source` discriminant check selects consumers of `CompiledProcedureRole` or
its source matcher through canonical imports. A Procedure's authored source text
is not that discriminant. SDK mission consumers retain `kind`, `type`, and `format`
dispatch checks without confusing source-text comparisons with role dispatch.
Public runtime/runner/browser acceptances verify behavior. Code Moniker verifies
the declared structural policy. These complementary forms of evidence must not
be presented as interchangeable guarantees.
