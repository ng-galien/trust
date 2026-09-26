# Shared access authority verification

Mission: `abac-access-authority-20260926`. On 2026-09-26, all three worker verification Checks and all three independent coordinator review Checks returned `COMPLETED` with `VALIDATED` qualification against frozen source and build artifacts. Unit verification observed six passing tests, integration two, and database three including PGlite and PostgreSQL; none failed, skipped, crashed or observed stale bytes. Response submission also returned `COMPLETED` / `VALIDATED` (Attempt `0d911508-02a9-4017-b036-0c3049fba929`); final coordinator observation is a separate transition.

| Worker Check | Accepted Attempt | Source/artifact digest |
| --- | --- | --- |
| Unit | `d72c190c-027e-4941-806c-647ebbf462d4` | `dd11c3ef436731cce968db6413b76caea76127595ad99730c8d1d3e92a6619f0` |
| Integration | `b774dc22-fed3-4daf-b892-8db5359d8e0a` | `4fc9dda32ce32a87976c29b16b4a57cf6fcf4c655e292ca751067092a0cab428` |
| Database | `3d96b134-59c6-4cd4-9a69-bc8b04eb0d91` | `b439ce4e14a8e6fc9433780a093ebce9c732a8b1696fc11f8f3270d311fe5a66` |

The independent reviewer was `root-independent-coordinator`; the worker did not execute its own review Checks. This document records returned qualifications, not a substitute for the Plan's immutable Facts or a claim of deployment.

## Authority and configuration

The runtime registers `AccessService` in its existing strict Awilix container. Explicit dependencies are validated `accessConfiguration`, `clock`, `accessFetch` and `accessSecretResolver`. The production secret resolver reads the existing CredentialService by `{environment, name}`; no secret value belongs in a public authentication configuration. Each introspection resolves the reference again. The service never stores a current user or bearer token.

The SDK owns `ExternalPrincipal`, the local/authenticated `AccessContext` union, its exhaustive `/match` matcher and the fixed action vocabulary. A verified context is deeply frozen at its mutable boundaries and registered by the issuing service. Shared service calls reject omitted, forged, foreign-service and local contexts. Passing a JSON object that looks like a context is not authentication. Expired contexts cannot authorize later service calls.

`authenticate(header)` validates the request credential; `authorize(context, action, owner?)` checks exact permission and optional ownership; `planScope(context, action)` supplies `own`/`all` to domain filtering; `principal(context)` supplies attribution. A missing `owner` performs only action preflight. An explicit null owner is historical unknown and refuses `own`; callers must supply the persisted creator when accessing a particular Plan. `all` does not grant a different action. Identity is exact issuer plus subject; client IDs and token IDs do not own resources.

Local mode is explicit `{mode: "local"}` and preserves existing local calls without token authentication. Configured shared mode is either `local-jwt` or `introspection`; there is no accept-any mode or online-to-offline fallback. The outer server configuration loader owns development-profile separation and rejects insecure loopback settings in shared deployment. Programmatic composition permits explicit dependency injection for signed public-boundary tests.

Shared configuration includes trusted issuer and audience, `discovery: "oidc" | "oauth"`, optional timeout (100–30,000 ms, default 5,000), maximum token age/lifetime (default 300 seconds), and clock tolerance (default zero). Strict parsing rejects unknown fields, modes, symmetric algorithms, insecure non-loopback endpoints and a generic JWT type lacking a configured access-token discriminator. The default local JWT profile requires `at+jwt`, RS256 and `iss/sub/aud/exp/iat/client_id/jti/scope`; a different provider profile needs an explicit validated contract. An exact expiration cutoff still applies to request contexts. Trusted discovered endpoints may retain query parameters; issuer URLs may not.

OAuth metadata uses the RFC 8414 well-known path; OIDC uses its discovery path. Both require exact configured issuer consistency. Requests never discover from token-supplied issuer or key URLs. Metadata and public keys have bounded five-minute caches; unknown-key refreshes are deduplicated with a 30-second cooldown. Network requests have bounded time/body size and refuse redirects. Existing cached keys do not establish current account permissions.

Introspection authenticates with the configured confidential client and credential reference using `client_secret_basic` or `client_secret_post`. Every protected request obtains a fresh response; no token or positive permission response is cached. Validation requires active bearer status, subject, intended audience, expiration and a well-formed standard scope string; returned issuer must match when present. The endpoint's trusted issuer supplies the principal issuer. Metadata may be cached; response activity and claims may not. Provider outage refuses access. This proves use of the response, **not** that the provider recalculates account roles: an active token's metadata may still be an issuance snapshot.

Permissions are literal OAuth scope values such as `trust.plan.read.own`, `trust.plan.read.all` and `trust.procedure.publish`. Unknown values grant no action. Fixed canonical actions replace transport aliases at the transport boundary; no wildcard, automatic role mapping or token permission union exists. Local JWT rights changes retain their issuance/expiry delay; online introspection provides only the active-state and metadata semantics the provider actually implements.

## Required tests and evidence boundaries

| Named test | What it establishes |
| --- | --- |
| `AUTH-POLICY exact actions and own scope deny missing or foreign authority` | Fixed action/ownership decisions, missing/foreign/unknown denial, no wildcard or token union, strict configuration and forged-context refusal |
| `AUTH-TRANSPORT local JWT and strict introspection validate each protected request` | Actual runtime HTTP RPC/MCP, mixed RPC batch, two concurrent principals, genuine maintained-provider Code+PKCE issuance, opaque-token introspection and revocation, no JWT fallback, signed negative profiles, exact discovery, rotation/cooldown, per-response permission consumption and outage refusal |
| `AUTH-DATABASE denied access leaves actual persisted state unchanged` | Successful permitted Environment/Credential writes followed by refused mutations and full public-table row comparisons through actual PGlite and PostgreSQL runtime databases |

The development provider fixture runs a maintained OIDC provider with real protocol endpoints. A separate bounded signed-issuer fixture controls invalid metadata, negative token profiles and failures that a correct provider should not normally emit. It uses jose signatures and real HTTP discovery/JWKS, never an unsigned token bypass. Tests do not establish Google enterprise login or provider-specific current-role recomputation.

Observed local evidence: the unit test and five nested cases passed; the integration test and its signed negative-boundary subtest passed; the database test passed separate PGlite and PostgreSQL cases. Integration/database tests host the real runtime container and HTTP handlers on loopback in the test process, exercising requests through RPC/MCP rather than invoking domain methods to simulate HTTP outcomes. The database proof inspects every public base table after each refused mutation, including seeded Environment and Credential records. This is an actual persisted-state comparison, not a mocked store assertion.

The maintained provider's revoked opaque token returns inactive and is refused with 401. That provider instead rejects introspection of its stateless JWT profile at the endpoint; TRUST returns 503 because no valid online authority response exists, even though local signature validation could have succeeded. This distinction is asserted explicitly. Initial local fixture failures (missing temporary operations directory, then an incorrect expectation of 401 for unsupported JWT introspection) were corrected and the affected test rerun successfully.

Run only after a coordinated build of SDK/runtime dependencies. The PostgreSQL test requires `TRUST_ACCEPTANCE_POSTGRES_URL` or `COORDINATION_VERIFICATION_DATABASE_URL` pointing at the approved disposable-database host; it creates and drops a uniquely named database. It fails rather than silently skipping the adapter when that target is missing. Runtime PGlite storage is isolated under a temporary directory. Credentials are not printed. Retained runtime/databases remain untouched.

The source/artifact closure is shared by the three governed verification contracts. Execute those Checks only after the coordinator freezes source and build output. The independent coordinator reviews assertions, database targets and build provenance, then executes the review Checks. Worker response submission follows those reviews; the worker never executes its own review or completion-observation Checks.
