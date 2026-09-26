# Development authentication validation

Local implementation observations before the coordinated build freeze:

- `DEV-TOKEN signed development tokens and private credential handling`: passed. Actual maintained provider code/PKCE issuance, signed JWKS validation, changed signature rejection, account ceiling, opaque introspection/revocation, rejected revoked refresh, private file checks, origin restriction and concurrent refresh preserving subject.
- `DEV-TRANSPORT lightweight provider and Runner authenticate both RPC and OTLP`: passed after correcting the test's required `trust.check-read-request@1` RPC marker. The initial test established packaged Runner completion with `VALIDATED`, persisted OTLP receipts, isolated Shell environment and external HTTP, and refused bearer redirect following.
- `DEV-DATABASE authenticated Runner preserves durable principal and rejects foreign submission`: passed against both PGlite and a uniquely created PostgreSQL database. Actual packaged Runner completed; another principal's OTLP submission and finalization were denied with no new receipt, and owner/actor survived close/reopen.

These are three unique named tests. Repeated runs and the two database adapters are not counted as additional unique tests. The first combined run had two passes and one test-contract failure; the focused integration retry passed after fixing that test request. A later focused run expanded that same named integration test to drive actual packaged CLI acquisition and refresh; this is not an additional unique test. It exposed a real CLI defect: requesting offline access without explicit consent produced no refresh token. The CLI now requests consent. The coordinator rebuilt the Runner, and the expanded integration retest passed: real `auth.js` acquisition, invalid-state refusal, mode `0600`, callback listener shutdown, real `run.js` refresh, unchanged principal, authenticated RPC/OTLP completion, and no token output. Runner TypeScript no-emit checking passed. Governed worker Checks, independent coordinator reruns and complete architecture gate remain separate pending steps; this document does not assert their completion.

Run from the repository root after the coordinator builds SDK/runtime/shell and packages the Runner skill. Use an existing private shell environment for the database administrative connection; do not print it. The test creates and drops its own random database name and leaves the connection's original database intact.

```sh
export COORDINATION_VERIFICATION_DATABASE_URL="$TRUST_COORDINATION_DATABASE_URL"
node --test packages/trust-runtime/acceptance/access-development-unit.test.mjs packages/trust-runtime/acceptance/access-development-integration.test.mjs packages/trust-runtime/acceptance/access-development-database.test.mjs
```

Local execution used Node v26.7.0; oidc-provider emitted its unsupported-runtime warning because its supported deployment target is maintained Node LTS. Its in-memory adapter and development interaction warnings are intentional for this opt-in fixture. Do not interpret these local passes as production-provider certification. Use maintained Node LTS for the development launcher.

## Governed worker verification

On 2026-09-26, all three worker Checks for `abac-access-development-20260926` returned `COMPLETED` and `VALIDATED` through the packaged Runner on coordination runtime 4510. Each executed its one exact named assertion with passed=1, failed=0, skipped=0, crashed=0 and stale=0. The database assertion covers both disposable adapters. Source/artifact digests before and after each execution matched.

| Layer | Run ID | Bound digest |
| --- | --- | --- |
| unit | `583c62d8-e916-453e-9260-be033c5723e2` | `2ad37459d11a028b65c197963065441ee95af7acc009d9534992966bebc9e7b6` |
| integration | `e6bd246d-e502-4b9d-9cfa-1d2f090f360f` | `726e6ab62d5820457e3ec3e1589115587a0c1cd581571582977fc1bef8f5acfd` |
| database | `e9844b96-0a96-468e-b1f2-bfe27c6c11d7` | `09dd384e22f92525ef6f7e9a15995d781b4300beb3e1dc5c8edad187c22a8d7a` |

The full local Runner results are `/private/tmp/trust-development-verify-unit.json`, `/private/tmp/trust-development-verify-integration.json`, and `/private/tmp/trust-development-verify-database.json`; accepted Facts remain in the mission history. Each report contains Git HEAD, timestamps, Node executable/version, exact Node test configuration and hashed file closure. The distinct contract-bound digests are expected for the three different immutable verification contracts.

Independent review and final observation remain the coordinator's responsibility. No worker review, submission, activation, commit or retained-runtime restart was performed at this stage.


## Independent review and response

The coordinator independently reran all three review Checks on the frozen contract digests; the live Plan read at revision 9 showed all three `review` and all three `verify` Checks satisfied. The worker then replaced the complete response/outcome declaration snapshot with revision checking and executed the supplied `submit response` Check. It returned `COMPLETED` and `VALIDATED` with reason `the owner response is stored`. The result is `/private/tmp/trust-development-submitted.json`.

The accepted response records three unique named tests, the genuine provider behavior and lifecycle limits, and the distinction between procedural reviewer independence and authenticated reviewer identity. The final `observe completion` Check remains open for the coordinator. No source, test, packaged artifact or runtime configuration was changed during verification or submission.
