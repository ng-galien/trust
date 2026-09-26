# Shared access implementation status

Local commit preparation subsequently applied formatting/import organization and a small React dependency correction. The dated governed evidence below is preserved; it does not identify those later bytes. See the [commit preparation checks](../server-industrialization/commit-preparation-2026-09-26.md) for the fresh build, static checks and targeted public acceptances.

2026-09-26 — Authentication and shared extension integration are implemented and verified. All six implementation missions are COMPLETE, including their worker tests, independent replays, responses and final observations. No activation, deployment, retained runtime restart, schema change on retained databases, commit or push was performed. Subsequent configuration and Helm implementation is a separate milestone; the evidence below identifies the frozen ABAC source and artifacts.

## Completed core milestone

Four `agent-delegation@1.1.0` missions on the dedicated runtime `4510` completed their worker verification, independent replay, response and final observation:

| Mission | Implemented and observed behavior |
| --- | --- |
| `abac-access-authority-20260926` | Existing Awilix access authority; trusted external issuer; strict local JWT or fresh OAuth introspection; exact literal action permissions; immutable request contexts; real denied writes without persisted changes |
| `abac-access-ownership-20260926` | Immutable Plan creator; inherited child attribution; separate Attempt actor; own/all filtering before pagination; same-principal refresh; foreign submissions refused; PostgreSQL and PGlite persistence |
| `abac-access-development-20260926` | Lightweight maintained development provider; real packaged Runner Code+PKCE acquisition and refresh; private credential file; authenticated RPC/OTLP; external Shell/HTTP isolation |
| `abac-access-surfaces-20260926` | Validated configuration; actual SPA PKCE/nonce and callback/refresh/logout negatives; core transport and LSP admission/revalidation; authenticated real Trial diagnostics |

All **24 verification/review Checks** returned `COMPLETED` and `VALIDATED`. Twelve top-level named groups were bound to requirements; their Node subtests yielded twenty passing observations per full run. Repeats are not additional unique tests. The [review matrix](core-verified-matrix.json) records exact accepted review attempts, run IDs, expected worker/source/after digests and assertion statuses. Every comparison matched, with zero failures, skips, crashes or stale results.

The coordinator built TypeScript project references, checked the UI and packaged the Runner before freezing the milestone. The full [Code Moniker report](core-architecture-report.txt) found zero violations across 736 scanned files. Those observations bind the frozen core milestone; later integration changes require fresh evidence. The supplementary UI mission therefore includes all twelve core groups again, rather than treating older green results as proof of newer source.

Reviewer separation is procedural in the existing coordination runtime. A digest identifies source and compiled bytes but is not cryptographic build provenance. Installed dependency versions and Node version remain part of the inspected local execution environment. The provider warns under local Node 26; maintained Node LTS is the documented launcher target.

## Completed extension integration

The initial access layer safely refused unclassified extension reads/commands and could not load bearer-protected federated module bundles. This is **not an accepted product exclusion**: it prevents shared coordination and mobile workflows. Two replacement supplemental missions are created under the approved extension-use decision. The original extension missions remain unqualified, superseded historical Plans; their immutable instructions described the earlier fine-permission proposal:

- `abac-access-extension-access-v2-20260926`: verified per-request IPC context, one exact use permission per installed extension, independent core Plan controls, equivalent custom MCP and HTTP behavior.
- `abac-access-extension-ui-v2-20260926`: confined public static assets, host-provided scoped authenticated fetch/SSE, real coordination/mobile pages and authorized actions, refused mutations without persistence, and all core regression groups.

The product owner explicitly approved **one general use permission per extension** for this version: `trust.extension.<canonical-extension-id>.use`. It authorizes the extension's own functions and data globally; no per-command catalog or new ownership of extension objects is introduced. The external provider grants this scope; an extension cannot grant it to itself. There is no wildcard across extensions. Fine extension-declared permissions are a possible future evolution, not part of this implementation. This decision supersedes the earlier resource/action granularity proposal and the pending ownership question.

Core controls remain independent. Using an extension does not grant Plan reads or mutations, publication, credential management or extension lifecycle actions. Any extension path that accesses the core applies its existing exact action and own/all authorization. Coordination agent labels never identify external principals.

Installed federated JavaScript shares the host browser realm. The transport prevents accidental bearer forwarding; it does not sandbox malicious installed code. Only executable bundle assets are candidates for public serving; backend files, data, credentials and traversal paths must remain inaccessible.

The integrated TypeScript build, UI typecheck, three extension server/UI builds and packaged Runner build pass. The [final architecture report](extension-architecture-report.txt) records zero violations across 751 scanned files. The five existing public extension compatibility acceptances pass. Backend extension integration and database assertions pass with actual child processes and PostgreSQL extension stores; their core runtime variants use PGlite and PostgreSQL.

After the final build and source hold, the [public aggregate report](extension-public-preflight.json) records all ten named integration/database assertions: the two UI assertions plus eight core regressions. They produced thirteen passing Node observations including subtests, with no failures, skips, missing assertions or changed digests. The browser loaded real coordination/mobile pages, edited tags and responses, received live updates, and refused a second signed browser grant without extension-use permission without changing stored data.

The product owner directly confirmed the ABAC unit-test exception after automatic review rejected the earlier cross-task authorization. The final unit groups then passed without renaming or bypassing them. Both extension missions completed all three worker verification Checks, three independent review Checks, response submission and final completion observation. The [verified matrix](extension-verified-matrix.json) records all twelve Checks and both completion attempts: every result is VALIDATED, with expected/source/after digests identical and no failure, skip, crash, missing assertion or stale source.

The integrated groups contain eighteen distinct named assertions and twenty-six passing Node observations per full run, including subtests. Independent repetitions are not additional unique tests. Across the four core missions and two extension missions, thirty-six verification/review Checks were qualified. Historical superseded Plans remain preserved rather than falsely closed. The final integrated freeze was released only after both extension completion observations returned COMPLETE.

## Deployment boundaries

No production provider or Keycloak/Google realm has been modified or certified. Local JWT validation does not promise immediate permission withdrawal. Fresh introspection consumes the provider response but does not prove that provider recalculates account roles. TRUST sign-out removes browser credentials and cached data, not the provider session/grant. Existing unattributed data and any retained-schema conversion require the separately authorized, backed-up provisioning protocol.
