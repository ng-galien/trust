# Dragon Heist: a complete governed game

## Prerequisites and expected outcome

Use an approved disposable installation configured from the
[game README](../../extensions/dragon-heist/README.md), with the extension prepared
and running, its Operations and five Procedures published, and the packaged
Runner connected to that runtime. Credentials stay in the installation and Runner
Environment. A host capable of dispatching agents is separate from TRUST.

The demonstration finishes with the root Plan complete after the game has recorded
its score. It includes four nested levels, a parallel distraction, one deliberate
negative Check, an escalation and operator resumption. The exact score is random;
the tutorial escalation is not. A normal tutorial has ten distinct moves and an
additional admitted rune retry after intervention.

## Read the authored composition

Read all five sources, not only this diagram:

```text
dragon-heist-game       scout; wait for both branches; score
├── dragon-heist-heist  equip; wait for vault; escape
│   └── dragon-heist-vault  inspect; wait for lock; open; take hoard
│       └── dragon-heist-lock  turn runes; open lock
└── dragon-heist-distraction  distract dragon
```

Sources: [game](../../assets/procedures/dragon-heist/05-game.feature),
[heist](../../assets/procedures/dragon-heist/03-heist.feature),
[vault](../../assets/procedures/dragon-heist/02-vault.feature),
[lock](../../assets/procedures/dragon-heist/01-lock.feature),
[distraction](../../assets/procedures/dragon-heist/04-distraction.feature).

TRUST creates child Plans automatically when their Invocations become eligible.
Each has its own intentions and current Checks. The host dispatches agents to
those returned Plan identifiers; creating a child Plan does not launch an agent.

## Who owns each decision?

| Concern | Owner in this example |
| --- | --- |
| Dice, choices, scoring, recorded moves and alarm | External game extension |
| Game identity and unique root Plan association | External SQLite constraints |
| Atomic state update plus move event, revision conflict | External game transaction |
| Move prerequisites, retained die, unchanged owner and choice on retry | External game validation |
| Check prerequisites, typed qualification, intentions, escalation and Plan progression | TRUST and the authored Procedures |
| Execute the granted HTTP Operation and report its complete produced values | Runner |
| Resolve an escalation and explain why work may resume | Operator through TRUST |

The external system has real invariants; TRUST does not replace them. Conversely,
an external invariant or successful move response cannot qualify a Check.
The [game server](../../extensions/dragon-heist/server.mjs) also verifies the
executing Plan's Environment, current ancestry, admitted Check and declared Input
through granted host reads. The credential alone is insufficient.

## From action to qualification

Read [the rune Operation](../../assets/operations/dragon-heist.turn-runes.feature).
It receives `game`, the executing `plan`, and `choice`. Its HTTP step calls
`game.move` using the Environment's URL and credential. The external response
contains booleans, die, score and game state. JSONata converts the booleans into
the declared string enums and returns **all thirteen Produced fields**.

The Runner reports those values as Facts. TRUST checks the complete schema and
evaluates the lock Procedure's qualification: recorded, ready and no alarm. The
first rune move is recorded but deliberately not ready, so a successful HTTP
response leads to `NOT_VALIDATED`, not a transport error or a completed Check.

## Play through the public boundaries

1. Engage `dragon-heist-game` at its published exact version through
   `trust_plan_engage`, with a fresh Plan identifier, the configured Environment
   and `rootInputs: { "game": "<fresh-game-id>" }`. Read the returned Plan.
2. Through the running extension's discovered `trust_extension_dragon_heist` tool,
   call `game.create` with the exact game and root Plan identifiers. Its equivalent
   public command endpoint is documented in the game README. Repeating the same
   pair preserves the game; do not repurpose an existing game for a new Plan.
3. Execute the supplied scout Check with the Runner. Read the resulting child
   Invocations. Dispatch the heist and distraction agents with their respective
   Plan identifiers, scope and Runner instructions.
4. On heist, replace its declarations using the current revision with `tool`
   set to `pick` or `charm`; execute equip. On distraction, declare `distraction`
   as `song` or `lure` and execute its Check. Do not pass these as root inputs.
5. Follow the returned vault child, execute inspect, then follow its lock child.
   Declare `tactic` as `force` or `listen` on that child. Run the rune Check with
   that Plan's own current intention, not a parent's intention.
6. Inspect the accepted negative result. Escalate that exact latest attempt with
   `trust_check_escalate`, explaining the blocking ward and the forbidden action
   of bypassing it. The child is escalated; ancestors expose its origin and block
   dependent work. The independent distraction can still complete.
7. In the IHM, follow the descendant escalation to the lock Plan. The operator
   resumes that escalation with a reason. Do not edit game storage or use an API
   shortcut that fabricates a successful move. Resumption does not satisfy the Check.
8. Read the lock Plan and retry its supplied rune Check. The game verifies the
   same Check's resumed escalation, preserves the recorded die, resolves the ward
   and deducts the concession penalty once. TRUST qualifies the new complete Facts.
9. Execute open lock, then follow current parent state: open vault, take hoard,
   escape, and finally the root score Check after both branches complete. Inspect
   the root's explicit completion and the table separately.

## Refusals and limits to observe

Trying another Plan, changing a recorded move's choice or using only a valid token
is refused. Retrying the ward without operator intervention preserves the die and
the unresolved alarm. A negative result is not a reason to reroll until it passes.

This example binds a recorded move to its original child Plan. A replacement child
generation cannot replay that move under a new owner; start a fresh game for fresh
play. An external action already performed cannot be undone by Plan invalidation.
The game is a trusted local demonstration, not a public multiplayer security boundary.

## Verification and next exercise

The [public game acceptance](../../extensions/dragon-heist/acceptance/http.acceptance.test.mjs)
uses a real host, Runner and OTLP with temporary databases. It covers lifecycle,
identity refusals, retained dice, escalation/resumption and one concession.
Runtime [four-level escalation acceptance](../../packages/trust-runtime/acceptance/child-plan-escalation.acceptance.test.ts)
separately covers descendant navigation, independent branches and supersession.
Neither replaces a human-visible IHM walkthrough with real agents.

For the next reusable example, follow [coordination delegation](../../extensions/coordination/DELEGATION.md):
external missions and their responses replace game moves, but only TRUST decides
Check qualification and Plan completion. Bundle distribution remains deferred.
