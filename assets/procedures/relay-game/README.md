# Relay dice game

Status: retained scenario specification; executable Procedures and Operations are
not yet authored or published. Run only after child Plan lifecycle validation.

The selected game is now [Dragon Heist](../dragon-heist/README.md). This document
retains the earlier relay concept rather than defining a second implementation.

This reusable integration exercise demonstrates governed multi-agent execution
outside a software-delivery workflow.

## Agreed game

- A game master starts the root Plan. One branch descends through three child
  Plans, giving four execution levels including the root.
- A short independent branch continues while the deep branch is blocked.
- A real external Operation rolls a die and records its result. Agents do not
  invent the roll or decide that their action qualified a Check.
- A roll can lead to continuing locally, passing play to a child, or requesting
  escalation. Precise face-to-action rules remain to be authored.
- Depth is bounded to four levels and play targets roughly ten actions. The
  scenario guarantees an escalation rather than relying on chance to cover it;
  randomness affects the game within those bounds.
- An Invocation creates its eligible child Plan automatically. Starting a host
  agent and directing it to that Plan remains a distinct orchestration action.
- Every Plan owns its independent intention chain and final validation. Child
  completion does not skip an explicit parent final Check.
- The deepest Plan escalates after an eligible failed Check. The game master
  follows the ancestor alert in the integrated browser to the originating Plan
  and explicitly authorizes resumption through the existing operator interface,
  not a direct API shortcut. Resume does not validate the failed Check.
- Finish bottom-up and retain the execution history for inspection.

## Before the first run

Author the exact die outcome contract, bounded branching rules and replay behavior
before implementing the external Operation. A retry must not silently replace a
known roll with a more favorable one. Keep a reproducible scenario mode for
acceptance coverage distinct from the random demonstration.

Place the reusable executable Procedure family here once it compiles against the
actual Operation catalog. Document child-first publication order, required
Environment values and the game master's launch/read/resume steps. Do not add
uncompilable placeholder Gherkin to the executable catalog.

Required observations: automatic children, four-level ancestry, independent
intentions, parallel branch progress, visible escalation origin, browser-driven
resumption and explicit final validation at each required level. A replacement
round may be added only if it fits the short action budget.

See [child Plan composition](../../../docs/todo/child-plan-composition.md) and its
[lifecycle acceptance checklist](../../../docs/todo/child-plan-lifecycle-acceptance.md).
