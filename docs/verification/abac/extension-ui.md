# Shared extension browser integration

The host supplies an authenticated transport to installed extension pages. Coordination, mobile companion and Dragon Heist consume that SDK contract instead of importing TRUST UI implementation or using ambient bearer state. The SDK contract is required: installed custom pages must adopt it to make authenticated data requests.

The approved permission for this version is one exact `trust.extension.<canonical-extension-id>.use` permission per installed extension. Extension-owned data uses this extension-wide permission. Core Plan projections continue to enforce the principal's independent Plan own/all permissions. Mission labels, assignees and other business labels do not create user identity or resource ownership.

Host navigation discovers installed page descriptors through the separate `trust.extension.list` permission. Direct extension API access needs its exact use permission; it does not imply catalog discovery, lifecycle administration, or core Plan access.

## Public code, protected data

`extension-assets.ts` mounts before runtime authentication and serves only GET/HEAD browser assets from the installed manifest's confined UI bundle directory. It rejects traversal and escaped symlinks, hidden paths, server/source/data directories, source maps, archives and arbitrary JSON. Browser JavaScript/CSS/font/image formats are allowed; the only JSON exception is the exact development `preview-version.json`. At the root of the bundle, only the manifest's declared entry and that preview marker are public. All assets revalidate, because the current remote entry URL can be rebuilt in place.

This is necessary for native module imports and their transitive browser chunks. Module Federation's manifest fetch hook cannot attach headers to the browser's native module-import graph. Neither public code delivery nor a loaded JavaScript module authorizes data access. Catalog, command, data, Plan projection and event routes remain behind server authorization.

## Host transport

`ExtensionPageProps.transport` provides `fetch` and `openEvents`; it never exposes a token getter. The host binds one transport to an exact runtime origin and canonical extension path, limits requests to that extension's data/command/Plan surfaces, rejects caller Authorization/Cookie overrides and credential URL parameters, and refuses redirects. Every request obtains the current token through the host's authentication object; cookies are omitted. Streams use fetch-based SSE, and logout or page disposal aborts requests and closes streams.

Coordination's list, suggestions, tags, Plan details and events use this transport. Mobile's project/feed/item/subject reads, response/conversation/notification commands, Plan episodes and events use a local React context carrying the supplied SDK contract. Dragon Heist's game/catalog/Plan reads and events also use it. Mobile external embedded content continues to use an unauthenticated external fetch/iframe; the host bearer is never supplied there. Development preview markers remain plain public asset reads.

The installed JavaScript runs in the host browser realm. This is a trusted-code integration with protection against accidental credential forwarding, not a sandbox against malicious installed JavaScript. No access or refresh token is placed in URLs, local storage, session storage, or service-worker state by the transport.

## Verification status

Local public validation passed the two exact named assertions below, using actual extension child processes, the maintained development issuer, disposable runtime stores, and a uniquely named PostgreSQL extension database. The integration assertion drives Chromium through real authorization-code/PKCE login and native Module Federation imports. It edits coordination tags and mobile responses, observes both live event refreshes, checks credential-free asset requests and bearer-protected commands/events, verifies token-free browser storage, and checks logout unmount. A second real browser grant omits extension permissions: its coordination read and attempted write through the actual host transport return 403 and preserve data.

- `EXTENSION-UI real federated coordination and mobile journeys authenticate`
- `EXTENSION-UI allowed commands persist and forbidden writes leave data unchanged`

The database assertion reads PostgreSQL tables through a separate connection after command completion. Allowed tag/response writes persist; absent or insufficient credentials cannot alter them. An extension-only grant cannot read core Plan details (privacy-preserving 404); another account with extension use can update shared extension data. It does not claim crash/restart recovery.

After the direct user authorization, the final asset/transport assertion, including nested server/source filename refusals, passed in both worker verification and independent review. Source typechecking, final bundles and `git diff --check` also passed before the freeze.

The replacement mission `abac-access-extension-ui-v2-20260926` is COMPLETE. All three worker and three independent review Checks are VALIDATED, with identical expected/source/after digests. Its fifteen named assertions repeat the authority, ownership, development and surface groups alongside the three extension UI assertions, yielding twenty-three passing observations including subtests. Response submission and final observation are complete. The original mission remains historical and unqualified after the permission decision changed. See [the integrated verified matrix](extension-verified-matrix.json) for attempts, digests and completion evidence.

Reproduction from the repository root uses the private environment without printing it, exports `COORDINATION_VERIFICATION_DATABASE_URL` from the configured coordination database URL, then runs:

```sh
node --test packages/trust-runtime/acceptance/access-extension-ui-integration.test.mjs packages/trust-runtime/acceptance/access-extension-ui-database.test.mjs
```

The connection is used only to create and drop uniquely named disposable databases. Retained runtime services and their databases are not restarted or modified by these tests.
