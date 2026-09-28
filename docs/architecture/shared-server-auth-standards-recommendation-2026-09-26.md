# External authentication and authorization for shared TRUST

This guidance concerns the shared external-OIDC profile. Explicit fixed and embedded development profiles are defined separately in the [server configuration reference](../reference/server-configuration.md).

## Recommendation and fixed decisions

Use an external OIDC/OAuth authority, with Google brokered through Keycloak for the requested scenario. Keep TRUST a resource server that validates access tokens and applies its own fixed action, ownership and domain rules. Do not create a TRUST password directory, token issuer or parallel user lifecycle. The approved server configuration selects local JWT verification or standard OAuth introspection at each protected request. No positive decision cache in strict online mode and no silent online-to-offline fallback. Token introspection alone is not proof of current permission recalculation. The choice is server configuration, not a remaining binary product blocker.

**Approved browser choice:** a public SPA client uses Authorization Code + PKCE S256 through the maintained provider-neutral oidc-client-ts client. Access and refresh tokens stay only in memory: no localStorage, sessionStorage, IndexedDB or client secret. Each protected request carries its access token. A BFF is a future alternative, not the current recommendation. This choice fits the requested internal enterprise application without adding a browser-session backend; it still requires HTTPS, trusted scripts/extensions and proportionate protection of powerful Trial and credential actions. It does not remove TRUST's durable business state and attribution.

**Approved integration choice:** authentication and rights have a dedicated authority in the existing Awilix runtime container, with explicit injected dependencies and an immutable context per request. Shared service instances never hold a mutable current principal. No authentication microservice is proposed. Literal OAuth scopes are selected. Numeric defaults below are configurable implementation recommendations, not universal policy.

**Approved extension granularity:** one exact `trust.extension.<canonical-extension-id>.use` scope grants general use of that extension's functions and its own data. No fine permission catalog or new extension-object ownership is introduced in this version. Core Plan actions and own/all restrictions, publication, credentials and extension lifecycle controls remain independent. The external provider grants access; an extension cannot grant itself permissions or use another extension implicitly.

The owner's latest decisions, reflected in the [current integration specification](shared-server-users-and-runner-spec-2026-09-25.md#fixed-authorization-rule), supersede the earlier study's role proposals and token ownership:

- A Plan creator is the immutable verified external `(issuer, subject)` principal. Children inherit the root creator. Tokens and `jti` values never own Plans.
- Every protected request presents an access token and requires the exact canonical action permission, the applicable `own`/`all` scope, and existing TRUST domain preconditions. Creator status grants no permission.
- Refresh or a new token for the same principal preserves identity. Attempts record their acting principal separately from the Plan creator. Rights from different tokens are never unioned.
- `own` compares verified principal with creator; `all` removes only that equality condition. Unknown historical creators are not inferred; the current specification limits them to `all`.
- One runtime owns each database. This recommendation adds neither multi-runtime coordination nor a new tenancy/role/policy language.

**Evidence labels:** “Standard” refers to the cited specification; “documented Keycloak behavior” is a vendor statement, not a test of an installed realm; “recommendation” is proposed design; “unproven” identifies provider/client behavior requiring acceptance evidence.

## Identity and trust boundaries

**Standard:** OIDC Core §5.7 identifies an end user by the combination of `iss` and `sub`; email and names do not have those uniqueness/stability guarantees. Pairwise subject identifiers can differ by client/sector (§8). [OIDC Core](https://openid.net/specs/openid-connect-core-1_0.html#ClaimStability).

**Recommendation:** configure one explicit Keycloak realm issuer for the scenario and derive creator/actor from its validated **access token**. Google authenticates upstream; TRUST trusts the configured broker issuer, not a Google token, an email suffix, an `actor` argument or MCP `clientInfo`. Keycloak documents Google login and brokered user linking; it may retain linked users in its own storage. That is compatible with having no native TRUST directory. [Keycloak administration: identity brokering](https://www.keycloak.org/docs/latest/server_admin/index.html#_identity_broker).

Specify and test subject stability across the web, Runner and MCP clients. If they receive different pairwise subjects, the same human will have different TRUST principals and will not automatically retain `own` access across those clients. Prefer a provider-supported stable subject arrangement for these trusted clients and prove actual access-token values; do not assume sharing a realm or a human account is sufficient. A broker/account deletion and recreation, issuer URL change, realm migration or pairwise-subject configuration is not ordinary refresh. Do not silently merge histories by email or normalize issuer strings. Such identity transitions require an explicit attribution policy.

For an independent automation, the acting principal is the externally authenticated service. For an agent using a developer's delegated access token, the token subject remains the responsible human unless a separately verified delegation protocol says otherwise. The client identifier names the OAuth application registration, not every agent process, device or run. Multiple instances may share a client. Persist optional asserted agent/run labels separately; they must not create authority or alter Plan ownership. If separately revocable instances are required, select a provider-supported per-instance credential/delegation mechanism and prove it; this study does not invent one.

## Local JWT validation and JWKS

**Standard:** RFC 9068 defines a JWT access-token profile with required claims and `at+jwt` typing; it requires signature, issuer, audience and expiry validation and permits contextual authorization checks. Its service-token subject can identify the client application. **Do not assume every Keycloak JWT follows that profile by default.** [RFC 9068 §§2, 4–5](https://www.rfc-editor.org/rfc/rfc9068.html#section-4).

**Standard:** JWT verification must constrain algorithms; different token kinds need disjoint validation rules. Arbitrary token-supplied key URLs can create SSRF. [RFC 8725 §§3.1, 3.8–3.12](https://www.rfc-editor.org/rfc/rfc8725.html#section-3). Discovery publishes issuer and `jwks_uri`; the returned issuer must match the issuer used to discover it. [OIDC Discovery §§3–4](https://openid.net/specs/openid-connect-discovery-1_0.html#ProviderConfigurationValidation).

**Recommended intake contract:**

1. Accept bearer access tokens only on protected API calls over the selected secure transport. Reject ID tokens, refresh tokens, wrong issuers and tokens intended for another API. ID tokens belong to client login validation, not API authorization.
2. Use a maintained verification library, a configured issuer allowlist, explicit algorithm policy and trusted discovery/JWKS endpoints. Validate the complete selected access-token profile, including expiry and `nbf` when present, with a small documented clock tolerance. Decide the exact Keycloak token type/claim contract from observed tokens before implementation; do not weaken token-kind separation to accommodate an unexplained mismatch.
3. Cache public keys in memory with bounded lifetime. A new unknown `kid` can trigger one controlled refresh; deduplicate/rate-limit refreshes and reject unknown keys after failure. Never follow an arbitrary token `jku`/`x5u`. Define key overlap and emergency key-removal handling operationally.
4. Key-cache success authenticates a signature; it does not refresh permission claims. During discovery/JWKS outage, optionally use already trusted cached keys within the approved cache policy, but never skip expiry, audience or signature validation. Missing keys or an exceeded freshness bound fail closed.
5. Do not accept an arbitrary maximum token lifetime just because `exp` is present. Configure an issuer/client lifetime and, if required, a server maximum token age; test skew and boundary behavior. An example starting point is a five-minute access lifetime, **a proposal rather than a standard or verified realm setting**.

TRUST needs no per-token issuance table for this baseline. It still needs trusted issuer/audience configuration, public-key caching, business persistence and audit. Authentication session state lives at the provider; the selected SPA holds its current tokens in memory.

## Rights freshness: the decisive choice

Checking a token on every request is different from checking current account permissions on every request. A signed permission claim is an issuance-time statement. A literal requirement that permissions never exceed the *present* account ceiling cannot be met by offline validation of an old JWT alone. The owner must define “effective” by a bounded propagation contract, or choose an online authority. This is a design constraint, not an authorization rule to silently relax.

| Event | Local JWT + embedded permission claims | What must be selected/proven |
| --- | --- | --- |
| Permission removed | Existing unexpired token can still contain it | Accepted withdrawal delay; provider stops reissuing it; no extra application cache extends it |
| Permission added | Existing token does not gain it | Refresh/new authorization and provider claim mapping yield the new permission; original grant/client scope may limit additions |
| Refresh | New token can have same `iss/sub`, different token ID and rights | Same creator and authorized actor continue; no permission union with prior token |
| Provider session logout | Does not inform an offline verifier by itself | Client session termination, refresh invalidation and any backchannel/online checks separately |
| Token/refresh revocation | Does not erase already distributed JWT bytes | What provider invalidates; resource-server visibility; propagation and cache bounds |
| Credential/client disabled | Does not alter the signature of prior JWTs | New issuance refusal plus chosen treatment of existing access tokens |
| Google access removed | Not automatically equivalent to immediate Keycloak session termination | Broker/session reauthentication and disablement policy; real-provider tests |

**Standard:** RFC 7009 separates revocation at the issuer from propagation to resource servers and discusses short-lived self-contained tokens as an alternative to online interaction. A successful revocation response does not prove an independent offline verifier has received that change. [RFC 7009 §§2.1, 3](https://www.rfc-editor.org/rfc/rfc7009.html#section-3).

**Recommendation A — baseline if bounded latency is accepted:** carry tightly mapped action/scope claims in the access token and evaluate them with resource attributes on every call. Keep refresh at the client/provider. No user/permission mirror in TRUST. Define the maximum withdrawal window as provider permission propagation plus any period in which it can still issue stale grants, plus the last such token's remaining accepted lifetime and clock tolerance. “Five-minute token” is not by itself proof of a five-minute end-to-end withdrawal guarantee. Rights additions require a fresh suitable token and may require renewed consent/authorization; refresh must not silently expand beyond an authorized grant.

**Recommendation B — when the required window is smaller or account state must be consulted:** use an online permission decision keyed by verified principal, client/grant context, exact action and resource attributes. If token permissions are a delegated upper bound, intersect them with the current account ceiling rather than letting a broad account decision elevate a narrow token. Unknown actions and unavailable decisions deny access. Cache, if chosen, must be keyed by all decision inputs and expire within the agreed bound. A decision cannot grant access that TRUST's domain rules refuse.

Keycloak Authorization Services documents a policy decision point and resource/scope permission evaluation, distinct from token introspection. It is an available candidate, not a required generic policy engine inside TRUST. Introducing it adds policy administration, resource/context integration, availability and caching obligations; obtaining an RPT and then validating that token offline still leaves a freshness question. [Keycloak Authorization Services](https://www.keycloak.org/docs/latest/authorization_services/index.html#_overview).

The fixed permission representation is the OAuth scope string; local JWT versus provider introspection is server-configurable. A small reviewed mapping from provider claims to existing canonical actions may be enough for A. B is justified only by a freshness or contextual-policy requirement. Neither an automatic mapping from every realm role nor self-selected scopes is acceptable evidence of permission. No obsolete named product roles are proposed here.

### Selected standard scope representation and configurable operating values

For A, recommend the standard OAuth `scope` string with a closed set of literal TRUST values. The container is standard; the names and their action mapping are application-specific. RFC 6749 defines space-delimited, case-sensitive scopes; RFC 9068 describes the access-token `scope` claim. [RFC 6749 §3.3](https://www.rfc-editor.org/rfc/rfc6749.html#section-3.3), [RFC 9068 §2.2.3](https://www.rfc-editor.org/rfc/rfc9068.html#section-2.2.3).

```json
{
  "scope": "openid trust.plan.read.own trust.check.attempt.admit.own trust.procedure.publish"
}
```

**Selected representation:** map each recognized literal through a fixed table to its exact canonical action and, for Plan-bound actions, `own` or `all`. For example, `trust.plan.read.own` maps to `plan.read` plus `own`; `trust.procedure.publish` maps to `procedure.publish` without ownership. No wildcard, prefix grant, generic policy grammar or claim-version field is needed. `openid` authenticates the login flow; it grants no TRUST action. Unknown scope values grant nothing; unknown requested actions, missing permission and malformed scope claims deny. Preserve verified identity (`iss`, `sub`), audience and lifetime checks separately. Exact names follow the canonical action inventory.

**Documented Keycloak support and proposed configuration:** client scopes can be optional, included in the token's `scope`, and restricted by role-scope mappings. Without such mappings every user is eligible; with them the user's roles must intersect the mapping, otherwise the scope is omitted. [Keycloak client scopes](https://www.keycloak.org/docs/latest/server_admin/index.html#_client_scopes). Propose fixed, role-gated optional scopes linked only to permitted clients; avoid broad default grants. Prove granted values are the intersection of account/service-account rights, client allowance and requested/authorized grant, including refresh and role removal. Requesting a scope or consenting to it cannot create account authority. Provider role administration stays external and does not add a TRUST role catalog. Do not use experimental parameterized scopes.

| Representation | Assessment |
| --- | --- |
| Standard `scope` string with literal action/ownership mapping | Recommended: fits the fixed action list, ordinary OAuth/MCP scope negotiation and Keycloak client scopes; account/client/grant restrictions still require configuration and proof |
| Custom versioned JSON permission claim | Possible, but adds a schema and mapper without a current need; reconsider only if approved structured resource conditions cannot fit the fixed action/ownership list |

**Proposed operating values for discussion:** access lifetime and accepted token age at most 300 seconds; verifier clock tolerance at most 30 seconds; client refresh when 30 seconds or less remain, serialized through the adapter. No additional effective-permission cache in the local-JWT baseline. These values are configurable recommended defaults and do not establish a 300-second end-to-end revocation promise: provider propagation plus the last stale token's accepted lifetime and clock tolerance must be measured. Reject a token whose declared lifetime exceeds the selected maximum. An addition becomes usable after successful issuance of a suitably authorized token; do not promise an upper bound for an idle/disconnected client. If the required account ceiling is literal online state, select B instead of describing these values as equivalent. Even an online decision has a request-time observation boundary and cannot recall an action already authorized and executed.

### What introspection can and cannot establish

**Standard:** RFC 7662 defines `active` and optional token metadata. It permits caching, prohibits caching beyond returned `exp`, and explicitly discusses stale revocation information. It also permits structured-token introspection to parse/validate the token and return its embedded information. It does not require recomputing current user roles. [RFC 7662 §§2, 4](https://www.rfc-editor.org/rfc/rfc7662.html#section-4).

**Documented Keycloak behavior:** the introspection endpoint reports token active state and is available to confidential clients; revocation supports access and refresh tokens. The documentation is not evidence that introspecting an old token recomputes updated role claims. [Keycloak OIDC endpoints](https://www.keycloak.org/securing-apps/oidc-layers#_endpoints).

**Recommendation:** introspection is an alternative for opaque tokens, or a supplement when tested active-state invalidation satisfies the desired logout/disablement behavior. It is not a substitute for B's current permission decision without specific evidence. Authenticate TRUST to the introspection endpoint; bound timeout/cache; distinguish inactive from unavailable; do not fail open to offline validation when the selected contract requires an online answer. A 30-second positive cache, if chosen, adds up to that duration after the provider reflects invalidation; it does not bound provider propagation or stale claim evaluation.

## Browser login, refresh and logout

**Standard:** use Authorization Code + PKCE (`S256`), exact registered redirects and transaction-bound protections against injection/CSRF; public-client refresh tokens need rotation or sender constraint. Password grant must not be used. [RFC 9700 §§2.1, 2.2, 2.4](https://www.rfc-editor.org/rfc/rfc9700.html#section-2). OIDC client login additionally validates ID-token issuer/audience/signature/expiry and nonce when used; this is separate from TRUST API access-token verification. [OIDC Core §3.1.3.7](https://openid.net/specs/openid-connect-core-1_0.html#IDTokenValidation).

| Choice | Recommended handling | Trade-off / selection trigger |
| --- | --- | --- |
| **SPA + PKCE, approved** | Public client without a client secret; maintained Keycloak adapter; access and refresh tokens only in memory; controlled refresh and narrowly configured redirects/origins | No new browser-session backend; compromised JS can access current tokens; reload may return through provider SSO, subject to provider session and browser privacy behavior |
| **BFF, future alternative only** | Confidential client, code + PKCE; server-held tokens; opaque Secure/HttpOnly/SameSite cookie, CSRF and Origin defenses; access token on every upstream call | Consider only if a later requirement justifies stronger token isolation and the added session/token storage, refresh and logout responsibilities |

The IETF browser-apps document read was **draft-ietf-oauth-browser-based-apps-27**, published 6 July 2026, not a final RFC. It describes the BFF managing tokens in a cookie session and forwarding access tokens; it requires Secure/HttpOnly cookies and discusses CSRF. BFF reduces token theft exposure, but cannot stop malicious script from invoking allowed actions through a user's active browser. [Browser-apps draft §6.1](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-browser-based-apps-27#section-6.1).

Keycloak's JS adapter documents code flow, in-memory access/refresh tokens and `updateToken`; it warns that third-party-cookie restrictions can delay detection of another-window logout until refresh. The approved design prohibits localStorage, sessionStorage and IndexedDB persistence of either token. [Keycloak JavaScript adapter](https://www.keycloak.org/securing-apps/javascript-adapter).

**Recommendation within the approved SPA design:** configure S256 explicitly, refresh before expiry with concurrency control, bounded retries and a terminal re-login path. Clear in-memory tokens on logout and use the selected provider logout/revocation mechanism; do not equate that with immediate invalidation of copied JWTs. Reload can repeat the redirect flow and benefit from provider SSO without another password when its session permits; do not promise silent SSO in every browser. Do not put refresh tokens in TRUST Plan state or forward them to the API. Memory-only storage reduces durable token exposure but does not protect tokens from malicious script in the running page. Use HTTPS, a controlled script/dependency surface and appropriate browser defenses; this residual risk does not reopen the owner's choice or require a BFF for this internal application.

## Runner, MCP and service accounts

**Standard:** a native human client uses an external user-agent and PKCE. Device authorization is useful when interactive browser/callback handling is unsuitable; it is not a universal replacement for capable native-client flows. [RFC 8252 §§4, 6](https://www.rfc-editor.org/rfc/rfc8252.html#section-6), [RFC 8628 §1](https://www.rfc-editor.org/rfc/rfc8628.html#section-1).

**Recommendation:** give the Runner a private credential-provider path outside the one-Check-URI contract. A human login helper can acquire/refresh the developer's access tokens; the Runner obtains a current token without exposing it in argv, semantic URIs, compiled sources, diagnostics or child environments. Use the configured TRUST origin/audience for RPC **and** live OTLP. Do not forward TRUST tokens to an Operation's external endpoints. Refresh between admission, Fact submission and finalization must preserve principal binding while rechecking each action's current effective permissions. Expiry after an external action must not cause blind re-execution: refresh and reconcile/submission-retry with the same Attempt where its existing rules permit it.

**Standard:** client credentials is for confidential clients and normally returns no refresh token. [RFC 6749 §4.4](https://www.rfc-editor.org/rfc/rfc6749.html#section-4.4). Keycloak documents built-in service accounts, token roles restricted by service-account roles and client scope mappings, and no refresh token/user session by default. [Keycloak service accounts](https://www.keycloak.org/docs/latest/server_admin/index.html#_service_accounts).

**Recommendation:** services obtain replacement access tokens using their own client authentication; never pretend this is a human login. Prefer asymmetric client authentication when operationally supported; never embed a confidential secret in a public SPA or distributed desktop client. Restrict the client's actions/audience and rotate its credential externally. Per-agent-instance attribution requires more than one shared `client_id`.

The current official MCP authorization page resolved to **2026-07-28**. Protected HTTP MCP uses OAuth resource-server validation, protected-resource metadata, authorization-server discovery, audience/resource binding and bearer headers on every request; tokens must not be in query strings. Authorization is optional in MCP generally, but required for TRUST's protected shared deployment. Standard MCP OAuth and a private pre-provisioned token configuration are not interchangeable interoperability claims. [MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization).

**Recommendation:** verify the actual MCP client's protocol version, OAuth discovery, registration, refresh and service-flow capabilities with the selected Keycloak version. OIDC discovery alone does not provide MCP protected-resource metadata. A confidential service flow is not automatically supported by every interactive MCP host. Preserve one shared authorization decision for RPC and MCP aliases. Validate Origin on MCP HTTP connections under its transport rules; that control supplements authentication. [MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#security--endpoint).

## Authentication in the existing Awilix container

**Recommended realization of the approved integration:** register a dedicated authentication-and-rights authority alongside those services, using typed dependencies for trusted issuer/audience/profile configuration, clock, JWKS acquisition/verification, and the selected permission mapping or online decision client. Keep transport-token extraction in adapters; pass the validated token to this shared verifier and enforce canonical action rules through the common runtime path. Keep route handlers thin: they obtain context and invoke the authority rather than reimplementing permission decisions. Token verification and rights evaluation can remain separate internal components behind this authority, with one shared decision contract. No separate process, microservice, hidden global verifier or container lookup inside business services is needed. Configuration, cryptographic dependencies and network/clock boundaries must be injectable rather than hardwired into route handlers; the composition root owns their lifecycle.

A singleton may hold trusted configuration and a properly keyed public-key cache. It must **never** store `currentPrincipal`, the last request's permissions, bearer credentials or a mutable actor context. Verification creates a fresh, validated immutable value for that request, carrying principal, authenticated client where available, effective permissions/decision metadata and expiry. Pass that value explicitly to authorized service calls; do not attach it to singleton domain objects or share mutable decoded-claim collections. TypeScript `readonly` alone does not establish runtime isolation. Each batch action retains its own authorization decision; each stream retains only its own connection context and obeys freshness/expiry. Concurrent callers, refresh and asynchronous continuations must not replace another request's actor or permissions.

### Authorized lightweight development slice

The owner rejected a mandatory local Keycloak deployment. Daily development uses an opt-in lightweight maintained OAuth/OIDC test provider with real signatures, JWKS and standard flows. Selected: maintained `oidc-provider` 9.12.2, running as one disposable Node process with its standard development interactions. The mock candidate was rejected because its default active/revocation handling would not prove real lifecycle behavior. JWT access is tested locally; opaque access is used for the provider’s actual stateful introspection/revocation path. [Official project](https://github.com/panva/node-oidc-provider).

Use the same runtime verifier and rights component; private token acquisition/injection supports Runner/API without secrets in argv, logs or frontend configuration. Demo identity issuance belongs to development tooling, never the production runtime. Configuration is explicit, isolated and reproducible. Shared mode must not accept development defaults or test dependency wiring accidentally. No accept-any bearer or signature bypass. Keycloak is optional for full interoperability; Google enterprise brokering remains a separate integration proof. No enterprise credentials are necessary for daily work.

## Minimal durable attribution and audit

**Recommendation:** persist only what TRUST needs: creator issuer/subject on root/child Plans; acting issuer/subject on Attempts and relevant mutations; canonical action/resource, server time, outcome/denial reason and request/attempt correlation. Record authenticated client ID separately where available, optional token ID/fingerprint for investigation under a bounded retention policy, and the permission decision source/version/time needed to explain an authorization result. Never store raw bearer/refresh tokens or an entire token payload just to obtain an actor name.

A local external-principal reference is not a duplicate account directory. No native passwords, login sessions or token issuance state are required in the runtime baseline. Authentication audit is distinct from immutable execution Facts and does not turn an actor label into proof that an external action occurred. Operational logs alone are not durable creator attribution. Preserve old publisher/assignee labels as unverified history. Define data retention and deletion separately from business-history retention; this research makes no legal retention claim.

## Alternative triggers and remaining decisions

| Decision | Recommended starting point | Switch or extend when |
| --- | --- | --- |
| API validation | Local JWT + trusted JWKS | Opaque tokens or a required active-state check justify authenticated introspection |
| Effective permissions | Exact external action/scope claims, conditional on accepted bounded freshness | Current-account ceiling must be fresher than issuance snapshots: proven online decision or invalidation design |
| Browser | Approved public SPA, code + PKCE S256, maintained Keycloak adapter, memory-only tokens | A later explicit requirement for stronger token isolation justifies considering BFF session state and CSRF handling |
| Human Runner | Native external-browser code + PKCE | Callback unsuitable and provider/client supports device authorization |
| Independent service | Client credentials | Distinct instance delegation/attribution requires externally managed per-instance identity |

The dedicated access authority, thin transport adapters, stable attribution, scoped access and development tooling require separate positive/negative acceptance evidence. All provider endpoints and client settings belong to validated configuration/discovery from explicitly trusted issuers. Confidential introspection/service secrets remain server-side through secret references; public clients have no client secret. Profile/client interoperability, subject stability and provider lifecycle behavior are test requirements, not new product questionnaires.

The online mode validates token active state and metadata; do not equate this with recalculated account permissions. Test permission changes, revocation, logout and disabled accounts separately. A provider outage denies online requests; local verification remains validation on every request. Expiry/freshness also bounds stream access. Deny unauthorized Facts/finalization after rights withdrawal while preserving a recoverable Attempt; do not blindly replay an external action.

## Specific evidence required before claiming support

The following are public acceptance requirements, not an execution report. Run them against a disposable approved provider/realm and both database adapters as applicable; keep the retained runtime and enterprise accounts untouched.

| Proof group | Required positive and negative observations |
| --- | --- |
| JWT/profile | Valid configured access token succeeds; wrong issuer/audience/signature/algorithm, ID token, malformed claims, expired token and future `nbf` fail before side effects; clock tolerance boundaries explicit |
| Key lifecycle | Known cached key during bounded outage, new signing key, retired key and unknown-`kid` storm; prove refresh bounds and no attacker-controlled key fetch |
| Stable ownership | Two different tokens and refreshed token for same `iss/sub` retain own access with permission; same `sub` under different issuer and another subject do not; same owner without permission denied; children inherit creator; unknown historical creator not guessed |
| Permission change | Record issuance, change, provider observation and last allowed request times. Remove then add a permission; compare old JWT, refreshed JWT and fresh login. Prove grant/client ceilings and no token union |
| Introspection, if selected | Same old token before/after role removal, account disablement, client disablement, session logout and token revocation; record `active` separately from returned permission claims. Exercise positive/negative cache expiry and provider outage |
| External decisions, if selected | Correct principal/action/resource and contextual changes; narrowed token cannot inherit broader account rights; timeout/stale decision/unknown action denied; cache keys cannot mix principals or scopes |
| Browser/broker | Selected SPA code + PKCE S256 through maintained adapter, state/nonce, exact redirects, replay and wrong-issuer rejection; public registration without secret; access/refresh tokens absent from localStorage/sessionStorage/IndexedDB; serialized refresh, logout clearing, reload/SSO and privacy behavior. Disposable upstream broker proves generic brokering, not actual Google login; real Google proof needs separate approved configuration |
| Concurrent principals | Interleave two principals with different own/all permissions across delayed RPC, MCP, OTLP and stream requests; denied requests cannot mutate state, audit always records the correct actor, refresh of one caller cannot alter another; batch and reconnect cannot inherit prior context |
| Injectable service | Construct the actual runtime with explicit authentication dependencies and controlled clock/JWKS/decision endpoints in public acceptance; demonstrate deterministic expiry, key rotation and outage behavior through HTTP/MCP/OTLP. Verify one shared policy path and absence of cross-request mutable principal state through source inspection; no unit-only assertion substitutes for public evidence |
| Local development | Reproduce lightweight isolated signed provider, demo humans/service and rights from non-secret configuration; acquire tokens without disclosure; run SPA/Runner/API through the real signed verifier; demonstrate denied wrong/dev issuer in shared mode and no accept-any bypass; reset only disposable auth resources |
| Runner/OTLP | Token expires between admission and Facts; new token for same actor continues if permitted; foreign actor denied; stripped permissions deny; no token in external HTTP, subprocess environment, argv, URI or diagnostic output; reconcile interruption without repeating known side effects |
| Surfaces and streams | RPC/MCP alias equivalence; batch-item permission; extension/lifecycle/LSP/diagnostic/proxy no bypass; filtered totals/pagination/history/events; SSE expiry, reconnect/replay, permission withdrawal and issuer outage |
| Services/recovery | Service principal distinct from human; client-credentials reissuance with same identity and appropriate rights; restart/restore preserves creators/audit and does not restore revoked access through stale state; logout effects measured, never inferred |

A successful HTTP response, token refresh, or `active: true` is not sufficient evidence for these combined requirements. Each assertion must report the identity, request action, selected freshness policy and observed outcome without exposing credentials.

## Reference provenance and limits

Read on 2026-09-26: RFCs 9700, 9068, 8725, 7662, 7009; OIDC Core/Discovery incorporating errata set 2; supporting RFCs 6749, 8252 and 8628; current Keycloak OIDC/JS/admin/authorization, realm import and container guides; MCP 2026-07-28; HTML EventSource; browser-apps draft 27. The Keycloak Authorization Services page identifies version **26.7.4**; current online documentation does not establish the version/configuration of any installed provider. Links sit next to the claims they support. Vendor documentation and proposed acceptance scenarios are not results of provider tests.
