# Shared access surfaces

Mission `abac-access-surfaces-20260926`; independent reviewer `storage_schema_analyst`.
Implementation and local public acceptance completed; governed results are recorded separately in the final implementation report.

The server reads one absolute `TRUST_AUTH_CONFIG_FILE`, validates its profile, issuer, resource identifier, modes and public SPA projection before serving protected requests. No file keeps the existing local mode; shared installations must explicitly select the shared profile. There is no automatic production/shared detection. Programmatic composition accepts explicit dependencies; confidential introspection secrets resolve through the existing CredentialService. Bootstrap that reference through the authorized local provisioning process before enabling introspection. This implementation does not activate authentication on an existing server or migrate retained data.

RPC, MCP, OTLP, Plan events, extension routes, diagnostic events and LSP use the same Awilix access authority. Exact canonical scopes remain independent: a successful mutation does not subsequently fail because its caller lacks the permission for an optional read projection. MCP validates a supplied browser Origin against configured browser origin; native clients may omit Origin. The shell rejects combining its Basic access gate with the shared authentication configuration.

Browser Code + PKCE S256 uses `oidc-client-ts`, a random nonce and provider discovery. Issued tokens stay in page memory. Session storage holds only temporary OIDC transaction state. Authentication failure unmounts the application and clears query caches. Local "Sign out of TRUST" discards tokens; it does not claim provider logout or grant revocation. A generation guard prevents an in-flight refresh from restoring a signed-out session. Reload requires a new provider flow; provider SSO may avoid another login.

Fetch-based SSE carries bearer headers. Shared Plan streams filter by creator, emit no global event cursor and ask clients to reload filtered state after deletion. Introspection revalidates before protected notifications and every 15 seconds while idle; expiry closes streams. Browser LSP carries the access token in an offered WebSocket subprotocol header and selects only `trust-lsp` in the handshake response; each message reauthenticates. Reverse proxies must redact both Authorization and Sec-WebSocket-Protocol headers. Tokens never belong in URLs. Idle LSP closes at expiry; withdrawal is checked on its next message.

Shared Trials pass the verified request bearer only through the child Runner stdin job's existing diagnostics field. The external Operation receives no bearer in its environment or inputs. Shared runtime startup rejects an off-origin diagnostic receiver. Diagnostic POSTs refuse redirects. Trial permissions are catalog-wide actions, distinct from Plan ownership; a long Trial whose credential expires may lose diagnostics, with `diagnosticsFailures` reporting that outcome. No server refresh credential is inferred from a caller bearer.

Extension lifecycle and mapped Plan projections are protected. Arbitrary extension commands/reads fail closed in shared mode until an explicit access contract exists. Native module federation cannot attach bearer headers to module fetches, so shared extension pages explicitly display their unavailability. Local extension behavior remains available. This is a current functional limit, not a successful shared extension UI proof.

## Observed local acceptance

- Configuration: unknown/secret-bearing fields, insecure shared profile, wrong issuer/redirect and invalid environment selector are refused.
- Public transports: unauthenticated access refusal, token query refusal, wrong MCP Origin, minimal-scope MCP engagement, creator-filtered SSE, dedicated Session read, real LSP handshake/message, private bearer protocol selection.
- Online withdrawal: actual maintained provider opaque-token revocation closes an established Plan event stream before another event and rejects the next established LSP message.
- Trials: actual packaged Runner executes `git.head-read`, receives authenticated diagnostic events with zero diagnostic failures; caller token is absent from public Trial and SSE output; injected authorization parameters and anonymous diagnostics are refused.
- Real Chromium SPA: Alice signs in, creates a Plan, cannot delete Bob's Plan, sees a filtered list; persisted data survives PGlite reopen. No issued tokens in browser storage or URLs. Callback replay, nonce mismatch, failed refresh and concurrent logout/refresh are exercised.

`access-surfaces-{unit,integration,database}.test.mjs` are the three bound assertion groups. The database-labelled browser test uses PGlite; the separately governed ownership and Runner groups cover both PostgreSQL and PGlite. The fixture has fixed development accounts and ephemeral keys. It does not certify Keycloak, Google brokering, production account disablement, or provider-specific permission recalculation.

## Subsequent configuration milestone

This report records the earlier ABAC verification state. The later server-configuration work retires `TRUST_AUTH_CONFIG_FILE` in favor of the `authentication` section selected by `TRUST_CONFIG_FILE`; the development launcher now writes `runtime-configuration.json`. See the [current operator reference](../../../reference/server-configuration.md). These later changes have their own verification and do not rewrite this report's historical evidence.
