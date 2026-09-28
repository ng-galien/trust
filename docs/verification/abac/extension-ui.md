# Shared extension browser integration

The host supplies an authenticated transport to installed extension pages. Coordination, mobile companion and Dragon Heist consume that SDK contract instead of importing TRUST UI implementation or using ambient bearer state. The SDK contract is required: installed custom pages must adopt it to make authenticated data requests.

The approved permission for this version is one exact `trust.extension.<canonical-extension-id>.use` permission per installed extension. Extension-owned data uses this extension-wide permission. Core Plan projections continue to enforce the principal's independent Plan own/all permissions. Host navigation discovers installed page descriptors through the separate `trust.extension.list` permission. Direct extension API access needs its exact use permission; it does not imply catalog discovery, lifecycle administration, or core Plan access.

## Public code, protected data

`extension-assets.ts` mounts before runtime authentication and serves only GET/HEAD browser assets from the installed manifest's confined UI bundle directory. It rejects traversal and escaped symlinks, hidden paths, server/source/data directories, source maps, archives and arbitrary JSON. Browser JavaScript/CSS/font/image formats are allowed; the only JSON exception is the exact development `preview-version.json`. At the root of the bundle, only the manifest's declared entry and that preview marker are public. All assets revalidate, because the current remote entry URL can be rebuilt in place.

This is necessary for native module imports and their transitive browser chunks. Module Federation's manifest fetch hook cannot attach headers to the browser's native module-import graph. Neither public code delivery nor a loaded JavaScript module authorizes data access. Catalog, command, data, Plan projection and event routes remain behind server authorization.

## Host transport

`ExtensionPageProps.transport` provides `fetch` and `openEvents`; it never exposes a token getter. The host binds one transport to an exact runtime origin and canonical extension path, limits requests to that extension's data/command/Plan surfaces, rejects caller Authorization/Cookie overrides and credential URL parameters, and refuses redirects. Every request obtains the current token through the host's authentication object; cookies are omitted. Streams use fetch-based SSE, and logout or page disposal aborts requests and closes streams.

Coordination's list, suggestions, tags, Plan details and events use this transport. Mobile's project/feed/item/subject reads, response/conversation/notification commands, Plan episodes and events use a local React context carrying the supplied SDK contract. Dragon Heist's game/catalog/Plan reads and events also use it. Mobile external embedded content continues to use an unauthenticated external fetch/iframe; the host bearer is never supplied there. Development preview markers remain plain public asset reads.

The installed JavaScript runs in the host browser realm. This is a trusted-code integration with protection against accidental credential forwarding, not a sandbox against malicious installed JavaScript. No access or refresh token is placed in URLs, local storage, session storage, or service-worker state by the transport.
