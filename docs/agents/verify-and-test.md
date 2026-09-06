# Verify and test

## Prerequisites and outcome

Use a disposable validation runtime and approved external resources. Read the
Operation and Procedure sources before constructing observations. The outcome is
a report of executed public scenarios and limitations, not merely a successful
build or an inferred checklist verdict.

## Choose the boundary

| Method | What it checks | What it does not establish |
| --- | --- | --- |
| Compile | Source, types and compatible references | External execution or qualification |
| Operation simulation | Projection against supplied step results and Produced schema | Real external action or Plan progression |
| Trial | Real Operation execution in an Environment, outside a Plan | Facts or Check qualification |
| Dry-run Plan | Admission, operator Facts, qualification and cascade | External action; no Environment values are delegated |
| Live Plan with Runner | Actual action, reported Facts and TRUST verdict | Safety of unrelated or untested actions |

## Steps and working example

1. Compile the exact proposed sources. For [Dragon Heist](dragon-heist.md), compile
   Operations before publishing dependent Procedures, and children before parents.
2. Simulate positive, negative and malformed external results. For the
   [signal example](author-operation.md), `"blocked"` is a valid negative
   observation; a missing `signal` must not be disguised as an ordinary false result.
3. For a Trial, read its terminal report; starting one is not proof it completed.
   Cancellation or interruption can leave an external action already performed.
4. Engage a dry-run through the operator UI or public RPC `plan.engage` with
   `mode: "dry-run"`. Current MCP `trust_plan_engage` is live-only; do not invent
   a mode argument for it. Use the [dry-run cockpit](../../packages/trust-ui/src/docs/content/en/plans/dry-run.mdx)
   to supply complete Produced values and inspect the real verdict.
5. Re-observe a satisfied Check only in dry-run mode. Verify which dependencies
   reopen and that historical Facts remain. Try a missing required field and
   require atomic rejection before persistence, without checklist progression.
6. Run the live [Dragon walkthrough](dragon-heist.md) in an approved disposable
   installation. Include the first negative rune result, escalation, operator
   resumption, preserved die and the final root Check.

For automated verification, use public boundaries, not mocks of TRUST's verdict
or internal service unit tests. Simulated external step results are appropriate
inside Operation simulation; they are not permission to fabricate live Facts.

## Coverage and failure handling

For an authored Procedure, exercise its actual dependencies, declarations,
qualification failures and applicable recovery paths. A simple Procedure does not
need artificial nesting. When changing the composition runtime itself, coverage
must include three or four nested levels, an independent branch, isolated
simultaneous child intentions and obsolete-child refusal after replacement.

Do not equate all interruptions with `NOT_VALIDATED`. Without accepted Facts there
is no qualification. After an unknown external outcome, inspect current state
before retrying; an action that cannot safely be replayed requires operator help.
Do not increase test timeouts or weaken assertions to conceal a product failure.

## Existing public scenarios

- [MCP authoring](../../packages/trust-runtime/acceptance/mcp-authoring.acceptance.test.ts).
- [Dry-run RPC](../../packages/trust-runtime/acceptance/plan-dry-run.acceptance.test.ts).
- [Four-level escalation and resumption](../../packages/trust-runtime/acceptance/child-plan-escalation.acceptance.test.ts).
- [Final validation recovery](../../packages/trust-runtime/acceptance/child-plan-final-recovery.acceptance.test.ts).
- [Dragon HTTP host, Runner and OTLP](../../extensions/dragon-heist/acceptance/http.acceptance.test.mjs).

Report which scenarios actually ran, their result, the tested sources and remaining
gaps. Links to existing acceptance code are not claims that every test ran in the
current documentation change.
