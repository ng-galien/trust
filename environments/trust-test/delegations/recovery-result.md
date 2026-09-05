# Worker recovery consolidation — 2026-09-05

Outcome: the delegated implementation mission `trust-dogfood-recovery` reached COMPLETE, revision 6, with 4/4 Checks satisfied. The coordinator inspected the change, independently reran the public acceptances, then executed the final observation.

## Change

`packages/trust-runtime/src/http/mcp.ts` now renders existing immutable root business inputs under ENGAGEMENT CONTEXT. This is a generic Plan read improvement, not a delegation-specific rule or a new Fact observation. It makes original instructions, expected result and scope recoverable even after the Check that consumed them is satisfied.

`environments/trust-test/scripts/delegation-recovery.acceptance.test.mjs` discards a successful claim output, launches a new MCP client process with only the endpoint and Check URI, recovers exact multiline/quoted/Unicode inputs, and completes the Plan using rendered MCP intention templates. It does not replay the satisfied claim or read an RPC Plan DTO.

The recipe and integrated EN/FR pages also explain successor missions after immutable blocked responses. Existing blocked responses and Plan histories are not rewritten.

## Evidence

- Worker report: initial red executed 1 test and failed on missing engagement context; subsequent final run executed 3 tests, all passed, no skips. The worker also reported and corrected an intermediate assertion that read JSON request fields as table columns.
- Coordinator rerun: 3 tests executed, 3 passed, 0 skipped, covering completion, blocked/escalated response and fresh-client recovery.
- Full public runtime acceptance suite: 46 executed, 46 passed, 0 skipped.
- EN/FR documentation structure acceptance: 1 executed, 1 passed.
- Scoped Code Moniker check and `git diff --check`: no violations/errors. No new dependency or qualification boundary was introduced; existing architecture testimony was retained. Unmatched architecture rules are not additional behavioral evidence.

Coordinator rerun mission identifiers:

- `delegation-recovery-d4e137ea-a4ec-4532-922e-2467d2878339`
- `delegation-acceptance-f0ffcdef-6565-4d3a-8cb3-e81b7f219747`
- `delegation-acceptance-e00941ca-4f55-4fe9-b8b7-27b38262c953`

The test runtime was isolated at port 4438 with `/tmp/trust-recovery-acceptance.i9eAKH/runtime.sqlite`; tests used unique mission IDs in the existing PostgreSQL test environment.

## Actual delegation trace

- Assigned worker: `/root/recovery_worker`.
- Creation attempt: `5167eb77-f8ce-4814-804d-7ca14ed5e18a`.
- Worker submission: `c79def62-f0a8-43e9-a3bc-39f3f7dd927a`, COMPLETED / VALIDATED.
- Coordinator final observation: `95c46eb8-7d56-4fee-a79e-24748aee1ae4`, VALIDATED, next COMPLETE.
- Full worker report is retained in PostgreSQL and Plan declarations; local submission copy: `.trust/dogfood/recovery-response.json`.
- Plan: <http://127.0.0.1:4173/plans/trust-dogfood-recovery>.

After the mission completed, the coordinator gracefully restarted the shared dogfood runtime without resetting its database. A public MCP read confirmed the new context renderer and the retained COMPLETE 4/4 Plan on port 4318.

## Next boundary

The worker also reviewed [the extension lifecycle proposal](extensions-next.md) as a sparring partner. Two findings were incorporated: per-installation stop/locking does not grant exclusive ownership of a shared schema, and extension shutdown must not claim to drain independent runner activity.

The extension lifecycle and federated UI remain the next implementation slices, not completed features of this consolidation. The A3 Maket model still needs alignment when its MCP becomes available. No commit or push was made.
