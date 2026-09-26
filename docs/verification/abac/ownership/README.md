# Plan and Attempt ownership verification

Mission: `abac-access-ownership-20260926`, Procedure `agent-delegation@1.1.0`.

The implementation persists a Plan's immutable creator as the external `(issuer, subject)` pair. The verified request context supplies that value on new engagement. Every child generation inherits its parent's creator, so the whole composition retains its root creator. An Attempt separately records the principal that admitted it. A permitted `all` caller may create an Attempt on another creator's Plan without changing that creator. Shared-mode Facts, finalization, interruption, escalation and same-key admission require the Attempt's recorded actor as well as the exact action permission and Plan scope. A newly issued or refreshed token for the same principal can continue; a broader token for another principal cannot take over that Attempt.

The database stores no bearer credential or decoded token payload. Nullable creator/actor columns preserve unknown historical attribution and explicit local-mode behavior. Shared `own` cannot access an unknown creator; `all` still requires the requested action. Unknown historical Attempt actors cannot be continued in shared mode. No attribution repair endpoint or schema migration framework was added. Existing retained databases and runtimes were not changed or restarted. The new schema is prepared only on disposable databases for this evidence; existing incompatible schemas remain refused by the storage loader.

## Enforcement and projection

- `PlanRuntime` and `PlanReader` receive the singleton `AccessService`, but each method receives its own immutable access context explicitly. Every public entry point calls the authority; optional arguments do not bypass shared mode. The authority, owned by the authentication slice, accepts omitted context only in explicitly configured local mode and rejects unminted/forged contexts in shared mode.
- SQL filters apply creator scope before Plan/history pagination. List cursors include effective scope and, for `own`, principal identity. A foreign row cannot produce an extra continuation. Full detail, pinned Procedure source, Session and composed episode projections check their corresponding canonical action and ownership. `session.read` has a dedicated `readSessionBySlug` projection so it does not require an unrelated `plan.read` grant.
- Relevant mutations recheck authorization under the existing root transaction lock. Admission still checks revision, Session, dependencies, escalation and Environment before granting anything. Existing Fact completeness/correlation, dry-run/live boundaries and qualification behavior remain in force.
- Database triggers reject creator/actor changes and child links whose attribution differs from their parent. SDK Plan and Attempt projections expose nullable `creator` and `actor` references respectively.

## Named evidence

The three following exact names are bound by the persisted mission. Local runs passed before governed verification; local passes do not satisfy the Procedure's verification or independent review Checks.

| Layer | File and exact test name | Assertions |
| --- | --- | --- |
| Unit | [`access-ownership-unit.test.mjs`](../../../../packages/trust-runtime/acceptance/access-ownership-unit.test.mjs) — `PLAN-POLICY principal equality and token refresh preserve ownership` | Exact issuer/subject equality, case-sensitive subjects, different issuer denial, null never equals null, unchanged identity across client/token changes, permission narrowing, own/all and unknown action refusal. This tests the pure policy, not token provenance. |
| Integration | [`access-ownership-integration.test.mjs`](../../../../packages/trust-runtime/acceptance/access-ownership-integration.test.mjs) — `PLAN-TRANSPORT own and all access isolate real Plans and Attempts` | Actual maintained development OIDC provider, Authorization Code + PKCE and refresh; actual HTTP runtime on loopback with PGlite; concurrent Alice/Bob engagement/admission; creator and actor projections; own/all Plan/history filtering; no foreign continuation; scope-bound cursor refusal; foreign MCP read; foreign Facts/finalize/interrupt through RPC; foreign actor OTLP denial; unchanged persisted Attempts/receipts after denials; refresh continuation; stripped rights; Session-only read and finalization-only continuation without an unrelated Plan-read grant; unminted/local/undefined shared contexts; two-principal contested identifier race has one immutable winner. |
| Database | [`access-ownership-database.test.mjs`](../../../../packages/trust-runtime/acceptance/access-ownership-database.test.mjs) — `PLAN-DATABASE child inheritance and actor isolation persist across adapters` | Same public journey on new PGlite and PostgreSQL databases, SQL inspection of creator/actor, all-scope acting principal separate from creator, denial before receipt/state mutation, immutable-column constraints, child-attribution constraint, explicit historical-null fixture, own/all legacy visibility, actual close/reopen with persisted attribution. Both adapters are required; no skip fallback. |

Local observations: unit 1/1, integration 1/1, database 1/1 covering both adapters, with zero skips. Runtime TypeScript build and whitespace checks passed. The full `code-moniker check . --report` gate passed with zero violations across 729 files. Scoped Biome safe fixes were applied; existing non-null assertion warnings remain. The integration fixture initially needed the exact public request contract and mandatory MCP protocol header; those transport requirements are now used in the final tests.

The integration test's accepted Facts are operator Facts for disposable dry-run Plans. Its OTLP request is a deliberately unauthorized foreign-actor submission and must be rejected before ingestion; it is not evidence of successful live Runner execution. The identity/provider and Runner slices own successful live execution, cryptographic negative cases, revocation/freshness, browser behavior and credential secrecy. These ownership tests do not claim enterprise activation, complete authentication-provider coverage or production deployment readiness.

## Reproduction and resource boundary

Build the current source before execution:

```sh
npx tsc -b packages/trust-runtime --pretty false
node --test packages/trust-runtime/acceptance/access-ownership-unit.test.mjs
node --test packages/trust-runtime/acceptance/access-ownership-integration.test.mjs
node --test packages/trust-runtime/acceptance/access-ownership-database.test.mjs
```

The database journey requires an explicitly supplied `TRUST_ACCEPTANCE_POSTGRES_URL` or `COORDINATION_VERIFICATION_DATABASE_URL` and the normal PostgreSQL credential environment where needed. It creates random `trust_ownership_*` databases and drops only those targets. PGlite directories and OIDC provider state are task-owned temporary resources. Each runtime is closed before reopen or cleanup; no second runtime shares the database. Test helpers never print tokens, provider client secrets or database credentials. The maintained provider deliberately uses its development interactions and in-memory adapter on loopback; its warnings are expected for this isolated fixture, not production configuration advice.

The governed Runner strips `TRUST_*` from an external action's environment. The coordinator supplies `COORDINATION_VERIFICATION_DATABASE_URL` privately for the governed database Check. Do not weaken the test into a skip or point it at an existing retained business database.

## Handoff status

After the coordinator froze the source and artifacts, all three worker verification Checks returned `COMPLETED` and `VALIDATED` on 2026-09-26. Each executed its one exact named assertion with one pass, zero failures/skips/stale assertions, and identical before/after digests. The live Plan at revision 9 confirmed all three independent coordinator review Checks were satisfied on the same digests. Revision-checked response declarations were accepted at revision 10, then response submission returned `COMPLETED` and `VALIDATED` (Attempt `d2820438-c07c-40cc-a852-c573baa9f546`). Final coordinator observation remained open at handoff; response submission alone does not establish it. Source/artifact digests bind the paths declared in the mission; installed external dependencies and runtime versions still require independent build-provenance review.


| Worker verification | Accepted Attempt | Verified digest |
| --- | --- | --- |
| Unit | `fc49d164-37e3-4f9d-bd10-552143fcb380` | `d7fa9db59394e5e91b322a682c5e39534b613b9c26159baa80d89405c48b5650` |
| Integration | `8ab466d5-0608-4e1a-b3f9-fa35aa8c64fb` | `99f12ecc538be2518b381e37f54b6aa787589311115cbe849741d674bdb71eca` |
| Database (both adapters) | `efd41de3-8932-42dd-a088-f9510eec086a` | `852cf4f523a9f55130f791fb3d94c933e82fb4315f4824e26ae3daf65cb79d4f` |
