# Mobile companion extension

This extension is TRUST's phone entry point at `/mobile/mobile-companion/`. The route loads its federated React page without the desktop shell. The first view lists project conversations, each project opens a dated timeline, and a timeline item opens its full detail and optional response form. The timeline contains selected structured items: progress, explanations, questions, decisions, confirmations, reviews and document references. It does not copy Codex chat or its transcript. The app route, when configured, belongs to its project rather than to a separate application catalog. Zustand holds navigation, the menu, form-draft state, and the saved light/dark and blue/violet appearance choices. Blue is the default accent.

The page keeps already loaded timeline history during SSE and visibility refreshes by reading the feed through its oldest loaded item. Its styles are ordered through `ui/style.css`, with separate token, shell, navigation, timeline, detail, feedback and responsive files under `ui/styles/`.

The extension owns its projects, items, form definitions and submitted answers. TRUST Plans, Checks, Facts and qualification remain in the core runtime. A submitted mobile answer is an external observation, never a Check verdict. Agents read answers through the running extension's `trust_extension_mobile_companion` MCP tool; Operations can GET `/extensions/mobile-companion/api/responses/<item-id>`. The example [decision-read Operation](operations/mobile.response-decision-read.feature) projects a known string field into a Produced Fact. A Procedure must still qualify that Fact through its Check. The extension never infers Plan progress from an answer.

## Main checkout and retained service

Develop on the main branch of the existing checkout; Git worktrees are forbidden.
Keep retained storage outside build output. Follow [retained runtime maintenance](../../docs/verification/local-runtime/README.md)
for configuration inspection, verified backups and recovery. Rebuilding code
never authorizes resetting the core or extension databases. Keep installation
paths and live service inventories in private records outside Git.

## Storage and lifecycle

The extension accepts exactly one storage configuration: `databasePath` for a legacy, single-process PGlite directory, or `databaseUrl` for PostgreSQL on loopback. Both are separate from TRUST's core database. `prepare` creates schema version 5 in an empty store or verifies an existing version 5 schema; `start` verifies it again and starts push and change notifications. Neither action migrates data automatically. A PostgreSQL URL contains a host, port, database and application user, never a password. Pass the application password through the host's protected `PGPASSWORD` environment and declare `credentialEnvironment: ["PGPASSWORD"]` in the extension installation.

### PostgreSQL container and Workbench

Use the official `postgres:17-alpine` image, a named volume, SCRAM authentication and a loopback-only port. Create three distinct private password files outside the repository for the PostgreSQL administrator, `trust_mobile_app`, and `trust_mobile_reader` (at least 24 characters each, mode `0600`). Start the container with the administrator password file mounted read-only; the example uses port `15439` and volume `trust-mobile-pg-data`:

```sh
docker volume create trust-mobile-pg-data
docker run -d --name trust-mobile-postgres --restart unless-stopped \
  -p 127.0.0.1:15439:5432 \
  -e POSTGRES_PASSWORD_FILE=/run/secrets/admin-password \
  -e POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256 \
  -v /absolute/private/admin-password:/run/secrets/admin-password:ro \
  -v trust-mobile-pg-data:/var/lib/postgresql/data \
  postgres:17-alpine -c password_encryption=scram-sha-256
node extensions/mobile-companion/scripts/provision-postgres.mjs \
  postgresql://postgres@127.0.0.1:15439/postgres \
  /absolute/private/admin-password /absolute/private/app-password \
  /absolute/private/reader-password
```

The provisioning command creates an application-owned `trust_mobile_companion` database and two distinct login roles. It refuses existing roles or database names. Run the extension's `prepare` only for a **new**, empty database. To transfer an existing PGlite v5 store, close its host, keep the original directory unchanged, copy it to a private closed migration source, then run:

```sh
node extensions/mobile-companion/scripts/migrate-pglite-v5-to-postgres.mjs \
  /absolute/closed-pglite-copy \
  postgresql://trust_mobile_app@127.0.0.1:15439/trust_mobile_companion \
  /absolute/private/app-password
node extensions/mobile-companion/scripts/grant-workbench-readonly.mjs \
  postgresql://trust_mobile_app@127.0.0.1:15439/trust_mobile_companion \
  /absolute/private/app-password
```

The migration requires a target without `trust_mobile_companion` schema, copies every version 5 table in foreign-key order, including VAPID keys, subscriptions and delivery state, compares every source and destination row, and commits only after the comparison. The private PGlite source remains unchanged. Verify articles and versions, submitted answers, subject links, notification status and the public browser route before changing the retained host's `databaseUrl`. Stop writes during the final copy and cutover; a test migration from an older copy is not a final data backup.

The Workbench connection uses host `127.0.0.1`, port `15439`, database `trust_mobile_companion`, user `trust_mobile_reader`, and its separate private password. The reader can select the content and response tables but cannot insert, update, delete, create objects or read `push_keys`, push endpoints or the delivery outbox. It receives no default access to future tables. Keep the container port off Tailnet; the web preview's existing Tailnet mapping remains the only phone entry point.

Back up PostgreSQL with `pg_dump -Fc` to a private mode-`0600` file and verify a restore into a separate test database before removing any PGlite fallback:

```sh
umask 077
docker exec trust-mobile-postgres pg_dump -Fc -U postgres -d trust_mobile_companion \
  > /absolute/private/mobile-backup.dump
docker exec trust-mobile-postgres psql -U postgres -d postgres \
  -c 'CREATE DATABASE trust_mobile_restore_check OWNER trust_mobile_app'
docker exec -i trust-mobile-postgres pg_restore -U postgres \
  -d trust_mobile_restore_check --no-owner < /absolute/private/mobile-backup.dump
```

Compare restored table counts and representative article versions, responses and subject links, then remove only the temporary restore database. Retain the password files and named volume across container restarts. A volume is persistence, not a backup.

### Upgrade an existing v1 directory

First stop the extension and its host so PGlite closes. Record the current absolute `databasePath`, the response IDs and revisions to verify, and the current host and gateway configuration. Copy the **entire** closed directory to two separate locations: an untouched v1 backup and a candidate for v2. Keep the old directory too. For example:

```sh
cp -R -p /absolute/state/mobile-pglite /absolute/backup/mobile-pglite-v1
cp -R -p /absolute/backup/mobile-pglite-v1 /absolute/state/mobile-pglite-v2
node extensions/mobile-companion/scripts/upgrade-v1-v2.mjs \
  /absolute/state/mobile-pglite-v2 /absolute/backup/mobile-pglite-v1
cp -R -p /absolute/state/mobile-pglite-v2 /absolute/backup/mobile-pglite-v2-fallback
```

Use existing, accessible parent directories and distinct, non-nested paths. The CLI opens a temporary copy of the backup, requires both directories to be v1 with identical legacy data, and migrates only the candidate in one database transaction. It creates the push tables and VAPID key, sets the schema version to 2, then checks that every legacy table still has the same rows. It prints row counts and a success flag, never answer values or a data digest. Keep the backup untouched and private. Do not run the CLI against an open PGlite directory, and do not run it twice on the same candidate.

This produces a v2 candidate. Upgrade that closed candidate through v3, v4 and v5 as described below before starting the current host. Keep the v1 backup untouched.

### Upgrade an existing v2 directory

Stop the extension and host so PGlite closes. Record response IDs, revisions and timestamps to verify. Copy the entire closed directory to an untouched v2 backup and a separate v3 candidate. Use distinct, non-nested absolute paths with existing parent directories:

```sh
cp -R -p /absolute/state/mobile-pglite /absolute/backup/mobile-pglite-v2
cp -R -p /absolute/backup/mobile-pglite-v2 /absolute/state/mobile-pglite-v3
node extensions/mobile-companion/scripts/upgrade-v2-v3.mjs \
  /absolute/state/mobile-pglite-v3 /absolute/backup/mobile-pglite-v2
```

The CLI compares every user and push table against a temporary copy of the backup, adds template and article-version tables, source constraints and feed notification triggers in one transaction, and verifies the existing data is unchanged. It reports counts, never answer values, key material or a data digest. Keep the backup untouched and private. Do not open either directory concurrently or rerun the CLI on a v3 candidate.

### Upgrade an existing v3 directory

Stop the extension and host. Copy the entire closed v3 directory to an untouched backup and a separate v4 candidate, using distinct, non-nested absolute paths with existing parent directories:

```sh
cp -R -p /absolute/state/mobile-pglite /absolute/backup/mobile-pglite-v3
cp -R -p /absolute/backup/mobile-pglite-v3 /absolute/state/mobile-pglite-v4
node extensions/mobile-companion/scripts/upgrade-v3-v4.mjs \
  /absolute/state/mobile-pglite-v4 /absolute/backup/mobile-pglite-v3
```

The CLI adds conversation view state (`pinned`, `deleted_at`) and its change notification trigger, then compares every existing table with a temporary copy of the backup. It reports counts and `dataUnchanged`, without answer values or a data digest. Keep the v4 candidate closed and upgrade it to v5 before starting the current host. Keep the v3 backup closed and private.

### Upgrade an existing v4 directory

Stop the extension and host, and make sure no process has the PGlite directory open. Copy the **entire** closed v4 directory to an untouched backup and a separate v5 candidate. Use distinct, non-nested absolute paths:

```sh
cp -R -p /absolute/state/mobile-pglite /absolute/backup/mobile-pglite-v4
cp -R -p /absolute/backup/mobile-pglite-v4 /absolute/state/mobile-pglite-v5
node extensions/mobile-companion/scripts/upgrade-v4-v5.mjs \
  /absolute/state/mobile-pglite-v5 /absolute/backup/mobile-pglite-v4
```

The CLI checks version 4 and matching data in the candidate and a temporary copy of the backup, creates empty subject and link tables plus change notifications in one transaction, sets version 5, and confirms all prior table rows are unchanged. It reports counts without response values or digests. Point `databasePath` at the v5 candidate, start the same host, then verify prior answers, article versions and document links through HTTP/MCP before writing a subject. Keep the v4 backup closed and private; returning to it loses interactions accepted after cutover. An existing preview must not simply load this v5 bundle against a running v4 PGlite directory. A tested v4→v5 upgrade on an isolated copy does not mean an operator's retained preview has been upgraded.

The schema has relational projects, conversation view state, items, templates, article versions, forms, fields, choice options, responses, typed response values, push subscriptions and a per-item delivery outbox. Primary/foreign keys, source-mode CHECK constraints, deferred completeness triggers and immutable-history triggers protect accepted interactions. An item stores either raw Markdown or a template version plus JSONB data and frozen rendered Markdown, never both. `feed.publish` appends an immutable timeline event; an explanation can instead grow through `articles.revise` under one article ID with immutable versions and an optimistic version check. `articles.consolidate` preserves earlier explanation rows as aliases and removes their duplicate feed cards. Identical publishes and submissions are safe retries, while changed content or answers conflict. Preparation generates one VAPID keypair inside the configured store. Keep its private key confidential and stable across restarts; replacing it invalidates existing browser subscriptions.

## Durable subjects and source links

A subject is an extension-owned record with a stable ID, project, title, description and optimistic revision. It is distinct from a project conversation, an immutable feed item and a TRUST Plan. `subjects.put` creates or replaces the subject's complete ordered link set at `expectedRevision` (zero on creation). Each link has an ID, one of four types (`article`, `document`, `plan`, `decision`), a relation label, a description, an item ID, an exact `targetIdentity` and its own provenance statement. The write is transactional: a wrong document URL, article ID or item Plan, a cross-project item, or an unsubmitted decision is rejected without partially changing the subject. A `decision` link requires an actual response to an item of kind `decision`; a completed Plan does not become a human decision.

The public command surface exposes `subjects.list({project})`, `subjects.read({id})` and `subjects.put({id,project,title,description,expectedRevision,links})`. Read-only HTTP routes are `GET /extensions/mobile-companion/api/subjects?project=<id>` and `GET /extensions/mobile-companion/api/subjects/<id>`. Writes go through `POST /extensions/mobile-companion/commands` or the extension MCP command. Source identity and link provenance are returned in each read; callers do not have to infer relationships from names or Markdown. Replacing a subject's links requires the current revision and does not rewrite source items.

The project timeline lists its stored subjects. Opening one displays the linked sources, verifies each item against the stored exact target identity before offering navigation, and preserves `?subject=<id>` while visiting a source. The header returns from article, document or Plan episode to the same subject. A document's embedded reader returns to its item first, then to the subject. The Plan lane reads the live `trust.delegation-episode@1` projection for missions, Checks and imported results. These execution facts remain owned by TRUST; the subject link records only the editorial relationship. If no valid decision link exists, the page says that no decision is recorded. This first view follows one linked Plan in its execution lane; other linked Plans remain source links.

`templates.put/read/list` manage immutable, versioned Liquid Markdown templates with a JSON Schema for input data. `posts.publish` validates and freezes the rendered result. `articles.read/revise` read and edit one article with author, reason and version history. The reader renders safe Markdown, GFM tables and fenced `mermaid` diagrams. Four-column tables use short expandable rows on a phone, with the full scrollable table available from the same section; wide screens show the table directly. Mermaid renders in strict mode as inert SVG images; invalid diagrams show their source, and wide diagrams have a zoom control. A feed item that `supersedes` another appears as the current episode in the topic list; the earlier immutable item remains reachable from the detail's previous-version action and by its direct URL. The conversation list exposes `conversations.list/pin/delete/restore`; delete only hides its project conversation from this list, preserving the project and its items, and the page offers a short Undo action. Database triggers notify all open SSE clients after accepted changes.

A form uses a restricted JSON Schema object with `additionalProperties: false`, required fields, titles, string/choice/textarea, boolean and bounded number controls. An optional UI schema orders controls through `#/properties/<field>` scopes and vertical, horizontal or grouped layouts. Without one, schema property order is used. The server validates the complete answer against this supported subset before the relational write. Submission requires `expectedRevision: 0`; the one accepted answer has `formRevision: 1` and `responseRevision: 1`. Editing an accepted form or answer requires a new message ID in this first version.

## Notifications

This slice uses Web Push. The mobile menu offers an explicit **Enable** action; it requests browser notification permission, registers `/mobile/mobile-companion/sw.js` and saves the resulting subscription endpoint in the configured store. Chrome on Android can wake the service worker for a push when the page is closed. Each new `feed.publish` queues a delivery for active subscriptions in the same transaction as the item. The dispatcher sends a payload-free, VAPID-signed request to the browser push service, retries transient failures from durable outbox rows and disables endpoints that return 404 or 410. The service worker displays a generic alert and opens the feed when tapped. No item title, answer or Plan data is sent to the push provider. Open-page SSE and foreground refresh remain in place.

Set `pushSubject` in the extension installation configuration to a real `mailto:` contact or HTTPS URL before enabling push. The default allowed push origin is `https://fcm.googleapis.com` for Chrome; `pushAllowedOrigins` can name a comma-separated list of exact HTTPS origins for other browsers. HTTP loopback origins are accepted only when explicitly configured for an isolated acceptance fixture. Browser support, permission and outbound access to the push service are required. The server's 2xx response means the push service accepted a message; it does not prove that Android displayed it. A changed or expired browser subscription is re-registered when the page next opens, and a 404/410 endpoint is disabled until then. A real locked-screen delivery and notification tap still require a Z Fold check.

## Catalog, documents and one-origin gateway

`projects.put` registers a project ID, title, description, status and optional same-origin route. `feed.publish` appends a typed message under a registered project. Catalog routes and document URLs must begin with `/mobile/`; they cannot navigate to arbitrary external origins. A Maket document item uses the `path` returned by Maket's `maket_doc action=link`, such as `/mobile/apps/maket/documents/<id>/read`. The item detail opens the reader in a same-origin frame; the header returns to the same item without reloading the TRUST page. Maket owns the document and mobile reading controls. It does not own this extension's live forms or responses. Later publication of reviewed procedure outputs to Maket is separate and unimplemented.

The TRUST web host proxies `/mobile/apps/<project>/*` to a fixed, operator-configured `http://127.0.0.1:<port>` upstream. The same mapping works in the production `trust-shell` web host and Vite dev/preview. `pathMode: "strip"` removes the `/mobile/apps/<project>` prefix before forwarding HTTP and WebSocket requests; `"preserve"` passes it through. Both rewrite Host and supplied browser Origin and Referer headers to the loopback upstream, while the browser stays on the TRUST origin. Targets are parsed at startup, restricted to exact loopback HTTP origins, and never chosen by request parameters. Registering a catalog entry alone cannot create a proxy target. Maket requires `MAKET_BASE_PATH=/mobile/apps/maket` and a strip mapping; its `docs/mobile-document-viewer.md` is maintained in the Maket repository.

The embedded reader checks the gateway response before opening its frame. If Maket is stopped or the document URL is unavailable, the page shows an explanation and a retry button instead of a blank frame. Restart the same loopback Maket instance with its original data directory, then retry; an empty Maket directory will not contain the document named in an existing TRUST item.

Example installation file (use absolute paths appropriate to the host):

```json
{
  "extensions": [{
    "manifest": "/absolute/trust/extensions/mobile-companion/extension.json",
    "configuration": {
      "databaseUrl": "postgresql://trust_mobile_app@127.0.0.1:15439/trust_mobile_companion",
      "pushSubject": "mailto:your-real-contact@example.com"
    },
    "credentialEnvironment": ["PGPASSWORD"],
    "environment": "local",
    "grants": ["plans.read", "plans.subscribe"],
    "autoStart": false
  }]
}
```

Build the repository and extension, then start Maket on loopback using its base-path configuration. Start the TRUST common shell with one gateway map:

```sh
npm run build
npm run build --workspace=@trust-extension/mobile-companion
TRUST_INSTALL_ROOT="$PWD" \
TRUST_EXTENSIONS_FILE=/absolute/path/extensions.json \
TRUST_SERVER_STATE_DIRECTORY=/absolute/path/trust-state \
TRUST_HOST=127.0.0.1 TRUST_PORT=4318 TRUST_WEB_PORT=4173 \
TRUST_MOBILE_UPSTREAMS='{"maket":{"url":"http://127.0.0.1:24842","pathMode":"strip"}}' \
node packages/trust-shell/bin/trust.js server start
```

Before connecting real procedure data, supply `TRUST_WEB_ACCESS_PASSWORD` from a protected process environment (minimum 20 characters). When set, the compiled web host requires HTTP Basic authentication with username `mobile` on **every** page, runtime proxy route and WebSocket upgrade. It strips the Basic credential before forwarding to TRUST or Maket. This shared password is a narrow gate for one operator, not individual identity or per-project authorization. Keep the runtime bound to loopback and restrict the Tailnet ACL to the intended device. Vite dev/preview has no such gate. Do not put the password in the repository, a URL, or a shell-history command. The isolated preview may run without it; do not attach real procedure data to that preview.

Prepare and start `mobile-companion` from the local Extensions operator page or the runtime's `POST /extensions/mobile-companion/prepare` and `/start` endpoints. Stop it with `/stop` before database maintenance; stop the shell with SIGINT. The bare mobile URL is `http://127.0.0.1:4173/mobile/mobile-companion`. The Mac's existing private Tailscale Serve HTTPS mapping from port 18444 to `127.0.0.1:4173` can expose this *same* web origin to the phone once the operator starts and verifies the host. No extra Serve port or Funnel is needed. Do not expose Maket or the runtime separately.

For local UI iteration while the host remains running, use `npm run watch:ui --workspace=@trust-extension/mobile-companion`. The watcher builds into `.preview-build`, copies hashed assets to `dist`, and replaces `remoteEntry.js` and `preview-version.json` last. The mobile page polls the version and reloads when it changes; it defers that reload while a response form has unsent changes. A server change still requires a server build and extension restart. UI edits do not alter the configured database.

Tailscale controls reachability to the private origin. Without `TRUST_WEB_ACCESS_PASSWORD`, any Tailnet client allowed to reach it can also call TRUST HTTP/MCP routes. Extension capabilities limit what the extension reads from TRUST, not which client may call its commands. With the password, every browser-facing route is challenged, but all holders share the same access and TRUST does not record an individual mobile identity. Verify the Tailnet identity and access policy before using real decisions.

For the Z Fold check, open the private HTTPS mobile URL in Chrome, authenticate, add the site to the home screen, press **Enable**, grant browser and Android notification permission, and then close or lock the phone. Publish one clearly labeled test item from a trusted agent. Observe whether Android displays the alert, tap it to open the feed, submit a test form and verify the durable answer through `responses.read` and a governed Check. Record the actual observed result; a local browser event or push-service acceptance is not locked-phone evidence.

## Verification

```sh
npm run test:acceptance --workspace=@trust-extension/mobile-companion
npm run build --workspace=@trust/web
npx playwright test --config apps/trust-web/playwright.mobile.config.ts
npm run build --workspace=@trust/shell
node --test --test-name-pattern='trust server start serves|optional web password' packages/trust-shell/dist/acceptance/cli.acceptance.test.js
code-moniker check . --report
```

The extension acceptance starts a real runtime and PGlite directory, exercises prepare/start/stop, MCP publish/read, schema and answer conflicts, direct HTTP response reading, SQL constraints, restart persistence and a Runner-executed HTTP Operation qualified by a Procedure. It also upgrades a copied v1 database with an existing answer through v5 and checks the answer and timestamp through the public HTTP and MCP paths while the backup remains v1. Subject acceptance verifies transactional target identity, revision conflicts and refusal of an unanswered decision link. The push acceptance verifies a payload-free request, VAPID signature and expiry, endpoint allowlist, durable subscription, retry after a transient 503 and 410 cleanup against a fake push service. The opt-in PostgreSQL migration acceptance uses a real loopback database, migrates a closed v5 source and reads article history, responses, subjects and notification status through a second public runtime. The reader-role acceptance checks SELECT and denies write, CREATE and push-secret access. Browser acceptance exercises subject-to-source-to-subject navigation at 412 and 884 px on an isolated v5 runtime. Headless Chromium on this host reports notification permission denied even when automation grants it, so local browser acceptance does not claim a displayed OS notification. Shell acceptance checks the optional password on runtime and app routes and verifies that credentials are not forwarded. A separate local integration run used Maket's real document reader through the compiled TRUST shell and observed a live WebSocket update; that run does not prove locked-phone delivery.

## Functional presentation

The concise French presentation [TRUST — des procédures au suivi d’un projet](docs/fr/presentation.md)
is user-facing content published as an autonomous article in the extension. It explains
the three actors, Procedure/Plan execution, and the subject as an explicit aggregation
of articles, documents, execution and decisions. It distinguishes the existing
single-Plan execution view from future cross-Plan exploration.
