# Local commit preparation — 2026-09-26

The owner authorized local commits of authentication/authorization, unified configuration, Helm/image packaging and methodology curation. Preparation used the existing `main` checkout, with no worktree, push, publication or retained runtime change.

## Scope and source continuity

Before editing, all 1,067 image input hashes matched `helm-image-source.json`. All 2,148 entries from the final configuration review also matched, including the verification helper's synthetic entry. There was no intervening executable source drift.

The normal pre-commit Biome check found 101 errors in delivery files: mostly formatting/import organization, plus React dependency diagnostics, an assertion callback return and intentional control-character rejection. Preparation applied formatting and import organization only to the affected delivery paths. It added the missing transport dependency to the Dragon Heist detail effect, made an assertion callback explicitly return no value, and documented narrowly scoped lint exceptions for intentional stream/authentication reset dependencies and control-character rejection. No architecture rule, lint configuration or Git hook was disabled.

The initial image and governed Facts retain their original hashes. They are historical evidence; the Docker image was not rebuilt after these preparation edits. No completed mission was rewritten and no new governed qualification is claimed. Fresh checks below apply to the prepared sources.

## Fresh checks

| Check | Result |
| --- | --- |
| `git diff --check` and staged checks | Passed |
| `npm run check` | Passed, zero errors; 544 warnings and 46 informational diagnostics remain |
| `code-moniker check . --report` | Passed, zero violations across 805 scanned files; existing architectural rules retained |
| `tsc -b` | Passed |
| `npm run typecheck` | Passed, including workspace dependency checks |
| Three extension server/UI builds | Passed: coordination, mobile-companion, dragon-heist |
| Runner packaging | Passed |
| `AUTH-TRANSPORT local JWT and strict introspection validate each protected request` | Passed, including its negative-profile subtest |
| `CONFIG-STARTUP real server validates file and environment configuration` | Passed |
| `EXTENSION-UI real federated coordination and mobile journeys authenticate` | Passed on the authorized retry |

The first browser attempt failed before exercising the page because the macOS sandbox refused Chromium's Mach port registration (`bootstrap_check_in`, permission denied). The same test passed outside that sandbox in 16.54 seconds, including setup/teardown. The initial failure is not represented as a passing run. PostgreSQL fixture databases were disposable; the retained coordination database was only the administrator connection used to create those databases.

These three named public assertions were selected for the preparation changes. Earlier full governed replays and Kubernetes installation/upgrade tests were not rerun automatically. The public browser journey exercises coordination/mobile; Dragon Heist's dependency correction is covered by typechecking and its rebuilt bundle, without claiming a new Dragon Heist browser journey.

## Commit boundaries and exclusions

1. Verification-bearing coordination methodology, canonical Operation/Procedure sources, helper, tests and evidence.
2. Shared access and unified configuration together: SDK contracts, runtime, Runner, shell/Desktop, browser/extensions, development provider, acceptances and design/reference documentation. Their configuration contracts and entrypoints are coupled; separating them would leave an incomplete intermediate implementation.
3. Helm chart, generated schema, container recipe, smoke/acceptance scripts and dated delivery evidence. It depends on the preceding runtime/configuration commit.
4. Dated curation report/public snapshot and this preparation record.

The 15 unrelated quiz files are excluded and retained byte-for-byte. Local `.trust` data and credentials, caches, generated bundles, the Docker image, chart archive and external Maket export are not Git inputs. The curated public audit snapshot is intentional versioned evidence; its scope omits raw non-verification Fact values. A candidate-file scan found no private key, bearer JWT or provider credential; its only credential-shaped URLs were explicit dummy values in negative acceptance tests.

Each commit uses an explicit reviewed path list and the normal pre-commit hooks. Historical failed Kind runs, negative qualification and response-correction refusal remain in the delivery evidence.
