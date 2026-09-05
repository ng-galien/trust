# Dragon Heist

A bounded tabletop demonstration implemented outside the TRUST runtime. The
extension owns SQLite game state, random dice and an append-only move event journal.
TRUST owns admission, Facts, qualification, independent child Plans and escalation.

Build with `npm run build --workspace=@trust-extension/dragon-heist`. Explicitly
prepare the installed extension before starting it. Configuration requires an
absolute `dataDirectory` and the loopback `trustBaseUrl` ending in
`/extensions/dragon-heist/trust`. Grant `plans.read` and `plans.subscribe`, and pass
`DRAGON_HEIST_TOKEN` through the installation's `credentialEnvironment`. Use a
16–256 character token; the Runner's Environment `gameToken` must match. The
Runner's `gameUrl` is the full `/extensions/dragon-heist/commands` URL. Credentials
are never returned by the game or its catalog.

## Local live preview

Run `npm run demo:dragon-heist` after building the runtime and extension. The
launcher serves the host UI workspace sources through Vite development mode on
port 4187, with hot updates, and the runtime on port 4497. Restarting preserves
the databases under `.trust/dragon-heist`; it never engages or plays a new Plan.
Keep the current browser route while iterating on the editor and host styles.

Host UI hot updates are distinct from server updates: the runtime and language
server still need their targeted build and restart, and the federated game UI
currently uses the extension build. Do not describe those compiled surfaces as
hot-reloaded source code.

## Public surfaces

- `GET /api/games` returns `{ games }`, at most 30 recently changed games.
- `GET /api/games/<game>` returns the recorded table, moves and any concession.
- `GET /api/catalog` returns exact sources copied from the canonical assets during
  the server build, plus the rule mapping used by the game. `sourceKind: "bundled"`
  deliberately does not claim these are the runtime's currently published versions.
- `POST /commands` accepts `{ command, arguments }` for `game.create`, `game.read`
  and credentialed `game.move`; these commands are also declared through MCP.

Create the root Plan first, with root Input `game`, then call `game.create` with
`{ game, plan }`. Repeating that same pair preserves the table. Game IDs are bounded
alphanumeric identifiers allowing periods, hyphens and underscores. Moves accept
`{ game, move, plan, choice, token }`, where `plan` is the executing Check's own Plan
and `choice` is an empty string when unused. The backend verifies the public host
Plan's Environment, current ancestry, expected Procedure, own admitted Check and
declared choice. A secret alone does not authorize arbitrary table changes.

The move response has no wrapper:

```text
game, move, plan: string
recorded, ready, alarm, completed: boolean
die, score: number
tool, tactic, dragon, chest: string
```

The authored Operations convert booleans to the current grammar's typed string
enum Facts. HTTP action results remain booleans. A recorded completed game is not
itself a TRUST checklist verdict.

## Rules

Ten named moves form a short game: scout, equip, inspect-vault, turn-runes,
open-lock, open-vault, take-hoard, escape, distract and score. The distraction
branch is independent after scouting. The normal tutorial adds one turn-runes
retry after operator intervention, for eleven external move invocations.

`equip` chooses pick or charm. `turn-runes` records one random d6: listen adds a
safe two points, while force adds four only on a die of four or more. Pick with
force, or charm with listen, adds one synergy point. `distract` records another
d6: song adds a safe two, while lure adds four only on a die of four or more.
Taking the hoard adds five points. Other moves return `die: 0`. The catalog exposes
these scoring constants and descriptions directly from the execution rules.

The first turn-runes always triggers the tutorial ward, independently of the die.
It returns `ready: false`, so the authored Check is not validated. Retrying alone
returns the same recorded die and unresolved ward. After the agent escalates that
Check, an operator explicitly resumes its Plan through TRUST. The next admitted
retry verifies that exact Check's resumed escalation through the host-granted Plan
read, preserves the die, records the concession and deducts two points once.
The game has no command that fabricates or directly clears a TRUST escalation.

Moves are identified by game and named move. Changing a recorded move's owning
Plan or choice is refused. This first demonstration does not replay an already
recorded move into a replacement child generation; use a new game for fresh play.
An admitted external action cannot be undone by a later Plan transition.

## Acceptance evidence

`node --test extensions/dragon-heist/acceptance/http.acceptance.test.mjs` exercises
the real runtime HTTP host, packaged Runner and OTLP with temporary runtime and
game databases. It covers lifecycle, repeat-safe creation, token and owning-tree
refusals, mismatched declared choice, exact bundled catalog sources, dice retention
across retries and stop/start, unresolved alarm without intervention, actual
same-Check escalation/resumption and the single recorded concession. The loopback
proxy in the test only forwards real host responses to accommodate an ephemeral
runtime port; it supplies no invented Plan data.

This extension is a local trusted demonstration, not a public multiplayer security
boundary. The game UI reads recorded state and uses the existing operator interface
for escalation; it does not possess the Runner credential or infer qualification.
