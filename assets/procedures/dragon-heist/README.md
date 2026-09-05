# Dragon Heist

A live, bounded game played through real HTTP Operations and the generic Runner.
The game extension records moves and dice; TRUST qualifies the returned Facts.
Neither a game score nor a worker's description completes a Plan.

## Launch the table

From the repository root, build the runtime, host and Dragon Heist extension, then run:

```sh
node scripts/dragon-heist-demo.mjs
```

The launcher uses runtime port **4497**, web port **4187**, and separate persistent
storage under `.trust/dragon-heist`. It does not reset the dogfooding database.
Open `http://127.0.0.1:4187/extensions/dragon-heist`. Startup publishes the catalog
but does not engage or play a game. Stop only the launcher-owned processes when done.

The selected Environment is `dragon-heist`. Its private `gameToken` matches the
extension's `DRAGON_HEIST_TOKEN`; `gameUrl` is the full extension commands URL.
The launcher generates and stores the credential locally. Do not copy it into
game arguments, agent messages, documentation or screenshots.

## Create a fresh match

Use the runtime's public RPC endpoint `http://127.0.0.1:4497/rpc`:

```json
{
  "jsonrpc": "2.0", "id": "engage", "method": "plan.engage",
  "params": {
    "contract": "trust.plan-engagement-request@1",
    "procedure": "dragon-heist-game", "procedureVersion": "1.0.0",
    "plan": "dragon-tutorial-1", "environment": "dragon-heist",
    "rootInputs": { "game": "dragon-tutorial-1" }
  }
}
```

Then POST the following body to
`http://127.0.0.1:4497/extensions/dragon-heist/commands`:

```json
{ "command": "game.create", "arguments": { "game": "dragon-tutorial-1", "plan": "dragon-tutorial-1" } }
```

Use a new identity for a new match. Repeating creation for the same game and root
Plan preserves its recorded moves.

## Play through Checks

Read each actual Plan with `trust_plan_read {"plan":"…"}`. Give the Runner one
returned semantic Check URI, carrying the exact current intention and, when the
Plan remains incomplete, an announced next intention. Read child identifiers from
the parent; never invent child Plan identifiers or executable URIs.

```text
game: scout → [heist and distraction] → score
  heist: equip → vault → escape
    vault: inspect-vault → lock → open-vault → take-hoard
      lock: turn-runes → open-lock
  distraction: distract
```

Before the relevant child Check, declare that child's choice using
`plan.declarations.replace`, its actual Plan identifier and its current
`expectedRevision`:

| Child Procedure | Declaration | Accepted choices |
| --- | --- | --- |
| dragon-heist-heist | `tool` | `pick`, `charm` |
| dragon-heist-lock | `tactic` | `force`, `listen` |
| dragon-heist-distraction | `distraction` | `song`, `lure` |

These choices belong to independent child Plans. The game refuses changing an
already recorded move's choice. The numeric `.feature` files publish child-first;
the table's rules/source panel exposes the actual Procedure and Operation sources.

## Tutorial alarm and operator resumption

The first `turn-runes` records a real d6 and a tutorial alarm. Its accepted Facts
produce `NOT_VALIDATED`. The acting agent must explicitly escalate that lock Check,
using its actual latest Attempt and a useful blocking reason; it must not manufacture
success, change tactic or reroll. The unrelated distraction can continue.

The operator opens the surfaced descendant escalation in the IHM and explicitly
resumes the lock Plan, accepting the score concession. The next Runner invocation
of the same Check lets the extension read that Plan's authoritative resumed
escalation history. It clears the alarm with the **same recorded die**. No caller
supplies a claimed resumption flag. Complete the remaining Checks bottom-up; root
`score` is unavailable until both the heist and distraction are complete.

There are ten named moves: normal tutorial play takes eleven Runner actions,
including the resumed observation. Repeating the blocked observation before
escalation adds no move or die roll. HTTP booleans are projected to the string
enums `"true"`/`"false"` in Facts because the current Produced grammar has no
boolean type; the HTTP action outcome retains its original types.

## Public acceptance

After building the runtime, Runner packaging dependencies and extension:

```sh
node --test packages/trust-runtime/dist/acceptance/dragon-heist-runner.acceptance.test.js
```

This uses an isolated runtime and game database, the packaged Runner, actual HTTP
moves and OTLP Fact export. Operator resumption uses the public RPC boundary used
by the IHM; manual IHM play is a separate integration check.
