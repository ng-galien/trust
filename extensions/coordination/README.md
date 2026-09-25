# Coordination extension

This trusted local extension owns a PostgreSQL read API and a separately built federated page. It does not qualify Checks, access the TRUST core database, or launch agents. Mission state and TRUST Plan qualification remain distinct.

To delegate work to an agent through this integration, follow [the delegation methodology](DELEGATION.md): persist the mission, dispatch the assigned worker, claim and submit through the Runner, then review and observe completion.

## Build and register

Build from the repository root after installing workspace dependencies:

```sh
npm run build --workspace=@trust-extension/coordination
```

The server bundle includes the PostgreSQL client and an exact copy of the authoritative schema at `environments/trust-test/manifests/postgres/002-missions.sql`. The browser remote is emitted separately in `dist`. Keep both beside `extension.json` when installing. No legacy SDK is used.

Set `TRUST_EXTENSIONS_FILE` before starting the common TRUST runtime to the absolute path of an installation file:

```json
{
  "extensions": [{
    "manifest": "/absolute/path/to/coordination/extension.json",
    "configuration": { "databaseUrl": "postgresql://flowlab@127.0.0.1:15432/flowlab" },
    "environment": "coordination",
    "grants": ["plans.read", "plans.subscribe"],
    "credentialEnvironment": ["PGPASSWORD"],
    "autoStart": false
  }]
}
```

The runtime receives `PGPASSWORD` through its server environment. Passwords do not belong in the manifest, browser properties, Plan inputs or database URL. Configuration and credential values are not returned by the public extension catalog.

## Lifecycle

- **Prepare** is an explicit operator action while stopped. It creates an absent coordination schema and the separate organizational classification schema transactionally under a database advisory lock. Existing compatible schemas are accepted without modification. An incomplete/incompatible schema is refused, never overwritten or migrated. Installing classification on a previous installation creates only its new schema; it does not alter existing mission tables.
- **Start** verifies the read schema and permissions, opens its own pool, then begins detecting changes. It never prepares implicitly.
- **Stop** closes only this extension's reads, timer and pool. It does not delete data, stop independent Runners, or modify their admission or qualification.

Read compatibility verifies the columns and types consumed by this extension and its SELECT privileges. It is not certification of the independent Runner's stored-function contract. Concurrent external schema changes are outside this preparation lock; maintenance remains an explicit operator decision.

The host runs server code in a bounded child process. This isolates ordinary crashes and hanging hooks, not malicious filesystem/network access. Browser federation shares the host JavaScript environment. Install only trusted code; granted wrappers are not a security sandbox or a new user authentication system.

## Read surface and updates

`GET /extensions/coordination/api/missions?limit=50` returns the most recently updated missions (1–100 rows). Each row comes from PostgreSQL: mission identifier, immutable request, assignment, owner, external state, response text and timestamps. This first view is bounded, not a complete history browser.

The federated page reads associated Plan state and current intent through the environment-filtered TRUST capability. Missing Plan data stays unavailable. A completed mission response does not imply independent review or successful qualification.

The host's event stream carries change signals, not authoritative state. On initial connection, reconnection or change, the page rereads its authorized sources. TRUST events and coordination changes are distinct: this first coordination extension polls the committed mission-event count and total classification revision every two seconds and emits a separate signal. Local tag edits also signal immediately. It does not require a database trigger, and direct SQL updates that bypass the mission functions do not produce a mission event. Explicit refresh remains available.

## One MCP tool and shared commands

The running extension contributes one tool, `trust_extension_coordination`, not one tool per command. Its input contains `command` and `arguments`. The same validated extension command service handles the tool and `POST /extensions/coordination/commands` from the UI.

- `missions.list` filters by search, external state, project, assignee and editable tags before applying its limit and offset. Tags are combined with AND. The result includes a total and each mission's tags and classification revision.
- `tags.replace` replaces a mission's organizational tags with an expected revision. Conflicting edits return a conflict instead of overwriting another user's changes. Tags are case-sensitive, trimmed, unique, at most 32 per mission and 64 characters each.

Classification lives in `trust_coordination_classification`, separately from immutable Plan labels, mission requests and responses. Editing it does not advance a Check or change a mission outcome. The original Plan labels remain available as a distinct read-only filter. Procedure and label filtering uses the authorized Plan summaries, not inferred task types; missions whose Plan is unavailable cannot be classified by those fields.

The MCP tool appears only while the extension is running. The host emits catalog-change notifications using its supported MCP 2025 Streamable HTTP transport; clients must rediscover tools to see changes. This does not automatically configure a new connection in every agent client.

The Kanban projects governed execution from each authorized linked Plan. A card is **Completed** only when `Plan.workState === COMPLETE`, and **Blocked** only when `Plan.workState === ESCALATED`; these terminal Plan states take precedence. With a nonterminal Plan, a created, unclaimed mission is Pending and a taken mission is In progress, including an external `completed` response waiting for the remaining qualifications. Missing Plan data is displayed in a separate Plan unavailable area and never inferred to be terminal.

External mission outcomes remain separate metadata: `completed` is shown as Response submitted and `blocked` as Blocker reported. They do not decide terminal board placement. The `missions.list` and `missions.suggest` state argument still filters the external database state, not this governed board projection. The Check fraction counts currently qualified Checks in the current Plan revision; its denominator can change and it is not a task completion percentage.

Compact Board and Stacked layouts retain the same grouping and date order; groups can be collapsed. Layout, collapsed groups, filters and sorting are carried in `coord.*` URL parameters. Facet autocomplete uses actual mission values from `missions.suggest`; procedure and immutable Plan-label choices come only from authorized Plan summaries. Suggestion limits are explicit and do not represent per-value mission counts. The page considers matching mission pages before Plan filters, up to its disclosed 2,000-mission loading limit.

The detail drawer is resizable and pinnable on desktop; mobile uses full width. Its Markdown sections can be collapsed without changing source text. Search and organizational filters are projections, not execution controls; there is no drag-and-drop mission-state mutation.

Instructions and responses remain original text in storage. The page renders Markdown and fenced Mermaid diagrams; this presentation does not change their business meaning or turn them into executable instructions.

## Verification and limits

The extension acceptance runs against a real runtime process and a disposable PostgreSQL database created by the supplied database administrator connection. It does not reseed the retained dogfood database:

```sh
TRUST_COORDINATION_DATABASE_URL=postgresql://flowlab@127.0.0.1:15432/flowlab \
  PGPASSWORD=flowlab node --test extensions/coordination/acceptance/lifecycle.acceptance.test.mjs
```

Build the runtime and extension first. PostgreSQL must permit creating a disposable database. The test drops only its freshly named database on cleanup. Generic host acceptances separately exercise process failures and capability boundaries; browser acceptances load the actual emitted federation remote.

The retained Kind PostgreSQL deployment still has no persistent volume. This extension does not add backups, durable orchestration recovery, schema migrations, a plugin marketplace, or distributed ownership.
