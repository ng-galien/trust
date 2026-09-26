# Server configuration and Helm delivery

Subsequent local commit preparation is recorded in [commit preparation checks](commit-preparation-2026-09-26.md). It includes formatting/import organization and a React dependency correction after the image and governed verification freeze. The successful image and Kind results below remain dated evidence for their original bytes, not a rebuilt image of the later commit.

Status at the delivery milestone on 2026-09-26: configuration and chart delivery are complete, with six named public-boundary acceptances verified by the workers and replayed independently. Both governed Plans have qualified final observations. **The third disposable Kubernetes run passed on the unchanged image and sources**, after capacity was recovered. Installation, served UI/health, anonymous refusal, Recreate upgrade, PVC marker persistence and PVC retention after uninstall were observed. The two earlier ENOSPC failures remain preserved; all three temporary clusters were removed. The actual local ARM64 image built successfully and the chart package is retained. No retained runtime was activated and no release was published. Local commits were authorized afterward.

| Deliverable | Outcome | Reference |
| --- | --- | --- |
| Unified configuration | Implemented, three public acceptances and three independent replays validated | [Operator reference](../../reference/server-configuration.md), [delivery report](configuration.md) |
| Helm chart | Implemented and packaged; three public acceptances and three independent replays validated | [Chart guide](../../../charts/trust/README.md), [delivery report](helm.md), [independent review](helm-independent-review.md) |
| Container image | Actual Linux ARM64 build passed; image ID `sha256:46e26dbc7f955db48506be627bf5db0b6e20a0f00e466fe74ad8c363586bfda5` | [Image provenance](helm-image.json) |
| Kubernetes installation | Third run PASSED: real installation, UI/health/anonymous refusal, Recreate upgrade, PVC marker persistence, uninstall retention and cluster cleanup | [Successful third attempt](helm-kind-smoke-attempt-3.json), [unchanged source/image check](helm-retry-source-check.json), [capacity history](infra.md) |
| Curation | Report independently reviewed, response and final observation qualified | [Completed audit](../curation/first-curation-2026-09-26.md) |

The local chart package is [trust-0.1.0.tgz](../../../.trust/abac-20260926/trust-0.1.0.tgz), SHA-256 `a079380a5cd1190d383c802ac13bf78c7dd3845c2d90ea88b7c42ed5e4322a4a`. It includes the container recipe and operator instructions. The successful Kubernetes run is separately recorded; packaging does not imply publication.

## Implemented behavior

One canonical SDK contract and schema now govern runtime, shell, Desktop and Runner startup. `TRUST_CONFIG_FILE` selects JSON; environment overrides file values, then defaults apply. Validation precedes startup, local configuration reports redact secrets, and source provenance is visible. Explicit catalog/log/storage paths and semantic authority survive child launch. Configuration changes require restart; existing authorized Environment, credential and registry updates retain their separate runtime semantics. The initial inventory remains [dated historical context](../../architecture/server-configuration-inventory-2026-09-26.md).

The chart configures one runtime/browser-shell workload per database, persistent state, existing Secret references, external PostgreSQL and provider-neutral shared authentication. It enforces one replica and Recreate rollout. Real host-process acceptances prove authenticated transport, extension access, competing-owner refusal and Plan persistence on PostgreSQL and PGlite. These tests translate physical mount locations from rendered Helm configuration; they are not Kubernetes installation proofs.

## Qualification and completion

[Verified matrix](verified-matrix.json) records all twelve current worker/reviewer Checks, exact assertion mappings, Attempt/run IDs, expected/source/after digests and both final observations. Every current result passed its single required named assertion with zero failures, skips, crashes, missing or stale results. Each independent pair matched the same 2,148-file closure. The six names are unique assertions; the worker/reviewer repetition must not inflate that count. Historical Procedure layer names remain `unit`, `integration` and `database`, but every test added for this delivery invokes a real public CLI, server or Helm boundary. No unit tests were added or executed for this work.

| Plan | Worker/reviewer Checks | Final observation |
| --- | --- | --- |
| `trust-server-configuration-v3-20260926` | 3 + 3 VALIDATED | `7b2000ef-7023-407b-b288-ad8c4e7547bd`, COMPLETE |
| `trust-server-helm-v3-20260926` | 3 + 3 VALIDATED | `60db02f2-b9cf-4f2a-9d9a-93cdded830e6`, COMPLETE |

The first independent Helm database replay produced a retained NOT_VALIDATED observation, Attempt `6b1b3a85-3598-44b9-8375-3f741f244060`, on unchanged bytes. Its structured report omitted the exception detail. A subsequent unchanged direct public diagnostic observed PostgreSQL SQLSTATE 53100 while creating a disposable database during Docker saturation. After the owned Kind cluster was removed and capacity recovered, the same OPEN Check passed a fresh replay, Attempt `60f7fa87-1e81-4e03-b001-4b56c2f1537e`. The negative history was not erased or relabeled. The Helm report separately corrects imprecise attribution in the immutable submitted response; the original response was preserved and recovered idempotently without direct history edits.

The final complete Code Moniker gate found **zero violations across 793 scanned files**; see [architecture report](architecture-report.txt). Required builds, Runner packaging/typecheck and dependency alignment passed. Compilation and architecture checks are distinct from behavioral observations. No further source edits occurred during the shared verification freeze; final reports and the Maket document were updated separately afterward.

## Replacement history and build provenance

| Original Plan | Expanded-input predecessor | Final verification Plan |
| --- | --- | --- |
| `trust-server-configuration-20260926` | `trust-server-configuration-v2-20260926` | `trust-server-configuration-v3-20260926` |
| `trust-server-helm-20260926` | `trust-server-helm-v2-20260926` | `trust-server-helm-v3-20260926` |

Both predecessor generations retain their actual history, without verification or fabricated completion. Initial review found omitted workspace manifests, desktop/shell sources, application assets, build configuration and executed artifacts. Actual image builds then exposed missing AGENTS.md and the coordination extension's SQL input, `environments/trust-test/manifests/postgres/002-missions.sql`. The final contracts bind 119 source paths and 15 artifact paths, including that SQL source. The third image build passed, with 1,067 input files unchanged before/after. Failed build logs are retained. Git HEAD alone is insufficient provenance for this shared dirty checkout; recorded hashes identify observed bytes but do not constitute a build attestation or dependency-integrity guarantee.

## Infrastructure recovery and retained state

The first two Kind runs used unique cluster names and explicit temporary kubeconfigs. Only those clusters and two demonstrably task-owned private failed-build cache records were removed. The final image, retained clusters, databases and unrelated images/volumes were preserved. After cleanup, Docker had approximately 2.7 GiB available under its configured 64 GiB limit; the host had approximately 68 GiB available. [Read-only diagnosis and bounded capacity proposal](infra.md) describe a possible owner-approved increase to 96 GiB and the interruption risk if Docker requires restart. No setting or restart was applied during that phase. Later, the coordination task reported owner-authorized removal of the two Shadok test clusters and their volumes. Before this task retried Kubernetes, live reads confirmed no Kind clusters and 11.2 GiB free. The unchanged smoke passed from 10:37:00 to 10:38:26 UTC; after cleanup, no Kind clusters remained and 11.2 GiB was still available. This task performed no additional cache purge, image rebuild or Docker settings change.

The Maket functional document, “TRUST — Serveur partagé · proposition multi-utilisateur”, now records the configuration precedence, single-owner deployment model, qualified Checks and successful bounded Kubernetes smoke after capacity recovery. Its layout was checked and the portable export regenerated. The prior ABAC milestone remains dated historical evidence and does not automatically certify later source changes.

The successful cluster run used persistent PGlite and placeholder shared HTTPS issuer configuration. Persistence means the volume marker survived the Pod replacement; authenticated Kubernetes requests, Kubernetes PostgreSQL integration, ingress/TLS-controller behavior and Plan persistence through a Kubernetes upgrade were not exercised. The earlier six public acceptances were not rerun: all 2,148 recorded source/artifact hashes and the image ID matched before and after this supplementary smoke. The completed governed Plans and their historical responses were not rewritten.
