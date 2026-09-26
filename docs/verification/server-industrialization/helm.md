# Helm and container verification

The chart and image recipe live under `charts/trust`. The chart consumes the canonical SDK configuration schema; explicit environment overrides are merged before required target validation. One replica, `Recreate` upgrades and the runtime's database ownership guard preserve the single-owner rule. Stateful files and Operations use a persistent volume even with external PostgreSQL.

## Public boundary observations

The three exact named public assertions passed locally and then through all three worker verification Checks on `trust-server-helm-v3-20260926` (runtime 4510):

| Assertion | Observed boundary |
| --- | --- |
| `HELM-CONTRACT chart validates and renders supported configuration` | Actual Helm lint/template, canonical schema equality, valid JWT/introspection references, refusal of replica/secret/unknown fields, and local package inspection |
| `HELM-RUNTIME rendered deployment starts the real configured TRUST server` | Actual shell CLI configuration/start, served built UI and health, anonymous RPC refusal, JWT from a maintained OAuth provider served over real TLS with a private disposable CA |
| `HELM-LIFECYCLE single-owner rollout and persistence contracts hold` | Actual shell processes on isolated PGlite and PostgreSQL stores; second owner refused; a Plan survives graceful stop/start on both adapters |

Host runtime tests translate only the rendered container installation and volume locations into temporary host directories. They are not evidence of a container or Kubernetes installation. The issuer fixture uses `oidc-provider` rather than an accept-any verifier. Its first token lifetime exceeded the configured maximum and was correctly refused; the fixture was corrected to issue 120-second tokens. No verifier policy was loosened.

Run from the checkout after the coordinated build:

```sh
node --test charts/trust/acceptance/render.acceptance.test.mjs
node --test charts/trust/acceptance/runtime.acceptance.test.mjs charts/trust/acceptance/lifecycle.acceptance.test.mjs
```

The lifecycle acceptance requires `COORDINATION_VERIFICATION_DATABASE_URL` or `TRUST_ACCEPTANCE_POSTGRES_URL` and the existing private database credential environment. It creates uniquely named databases and removes them afterward. Do not print that environment. No retained database or cluster is used. These are public CLI/server/Helm acceptances, regardless of the mission's historical layer label `unit`.

## Image and Kubernetes status

The actual local ARM64 image build passed as `trust-server:helm-20260926-local`, image ID `sha256:46e26dbc7f955db48506be627bf5db0b6e20a0f00e466fe74ad8c363586bfda5` (888,181,181 bytes), using `charts/trust/container/Dockerfile` and its dedicated ignore file. It compiled the runtime, SDK, shell, browser, documentation, Runner and all three extension bundles under Node 24.21.0, then pruned development dependencies. [Image provenance](helm-image.json) records the resolved official base digest and exact command. Git HEAD is `7d651cce67e1556e6a05d3036a2089dc49854300`; the checkout contains uncommitted changes, so the label alone is not complete provenance. The separate 1,067-file source snapshot at `.trust/abac-20260926/helm-image-source-before.json` matched every byte after the build. Build output and BuildKit metadata are retained beside it.

The first two real build attempts failed on missing context inputs: first `AGENTS.md`, then `environments/trust-test/manifests/postgres/002-missions.sql`, which the coordination bundle copies. Both exact files were added to the allowlist; the source closure was expanded before qualification. Failed logs remain `helm-image-build-attempt-1.log` and `helm-image-build-attempt-2.log`; the third attempt passed.

The disposable Kind script is `charts/trust/scripts/kind-smoke.mjs`. It accepts an explicit local image tag and absolute report path, creates a unique cluster and private temporary kubeconfig, loads that image, installs the chart, checks the real Service/UI/health/anonymous refusal, upgrades with `Recreate`, checks persisted volume data, uninstalls while verifying PVC retention, and removes only its own cluster. It does not target existing cluster contexts. The first actual execution failed during installation: the Pod could not create `/var/lib/trust/operations` because Docker Desktop storage was exhausted. The disposable cluster was removed. [First-attempt report](helm-kind-smoke-attempt-1.json) and [read-only storage diagnostics](helm-kind-diagnostics.json) preserve that observation. Two exact private cache records created by the first two failed image builds were independently reviewed and reclaimed (788.1 MB each); [cleanup provenance](helm-cache-cleanup.json) records fresh ownership guards, exact selectors and the unchanged final image ID. The [second unchanged smoke attempt](helm-kind-smoke-attempt-2.json) also encountered ENOSPC and removed its unique cluster after the bounded timeout. Only the two pre-existing retained clusters remained. A read-only filesystem check inside the existing PostgreSQL container then showed 2.7 GB available. At that stage no further cluster attempt or broader cleanup was performed; neither of those two attempts established successful installation, upgrade or uninstall.

The Kubernetes smoke uses persistent PGlite and strict shared authentication with placeholder external HTTPS issuer configuration. The successful third run below proves startup and fail-closed anonymous access. It does not prove successful authentication against a production provider, PostgreSQL inside Kubernetes, ingress/TLS-controller behavior, or Plan persistence across a Kubernetes upgrade; its persistence assertion checks a marker on the PVC. Actual authenticated requests and Plan persistence are independently covered by the host public acceptances above. No image/chart publication, enterprise deployment, retained-service activation or commit has occurred.

## Successful third Kubernetes run — coordinator follow-up

After the coordination task reported owner-authorized Shadok test-cluster cleanup, live checks found no Kind clusters and 11.2 GiB free in Docker. The image ID was unchanged, and every one of the 1,067 image-input files and 2,148 verified source/artifact entries matched the recorded hashes. The root coordinator ran the original smoke script without editing it or rebuilding the image. A private wrapper KUBECONFIG also confined cleanup to temporary configuration rather than the user's default kubeconfig.

[Attempt 3](helm-kind-smoke-attempt-3.json) ran from **2026-09-26T10:37:00.258Z to 10:38:26.904Z** in `trust-helm-f1870710`, exited zero, and recorded `status: passed` and `clusterRemoved: true`. It observed one ready Pod; served health, HTML and browser entry; HTTP 401 for anonymous RPC; a distinct ready Pod after Recreate upgrade; the same PVC marker after replacement; and a retained PVC after Helm uninstall. The disposable cluster was then removed. A final inventory found no Kind clusters and 11.2 GiB available. [Before/after provenance](helm-retry-source-check.json) confirms unchanged source/artifact hashes and image ID.

The two failed runs, negative governed replay and immutable mission response remain historical records. This supplementary cluster result does not rewrite those results or create new governed Facts. The six already-qualified public acceptances were not needlessly repeated. No extra purge, Docker setting change, restart, commit, push or publication occurred during this retry.

## Limits

`/health` proves initialized runtime responsiveness, not continuous database/provider availability. PGlite crash markers require an operator to establish that no owner remains before explicit recovery; there is no automatic takeover. `Recreate` applies to normal Deployment upgrades; manual force-deletion can overlap Pod lifetimes, so the runtime guard remains essential. Introspection credential references resolve TRUST's credential store and require prior authorized provisioning; Kubernetes Secret mounts alone do not create those credentials.

All three worker Checks on final replacement `trust-server-helm-v3-20260926` are `COMPLETED` and `VALIDATED`. [Worker results](helm-worker-checks.json) record one passing required assertion per group, zero failed/skipped/crashed/missing/stale assertions, matching before/after digests, and identical 2,148-file manifests across all groups. Independent reviewer CLI and authenticated-server replays passed. Its first database replay was `NOT_VALIDATED` with unchanged digests; a direct public lifecycle diagnostic identified PostgreSQL `CREATE DATABASE` failure SQLSTATE `53100` (no space left on device) while the second Kind attempt was active. That negative observation is preserved. After owned-cluster removal and restored disk availability, the same database Check passed a fresh independent replay (Attempt `60f7fa87-1e81-4e03-b001-4b56c2f1537e`) with identical source/artifact hashes. [Independent results](helm-independent-checks.json) record all three validated reviews. The response is submitted and validated. Final independent observation completed with `VALIDATED`, Attempt `60db02f2-b9cf-4f2a-9d9a-93cdded830e6`; the governed delivery Plan is `COMPLETE`. The original and v2 missions are preserved without verification under their incomplete build-input closures; v3 binds 119 source paths plus 15 artifact paths, including the discovered SQL source.

The local chart package is retained at `.trust/abac-20260926/trust-0.1.0.tgz`; [package provenance](helm-package.json) records its SHA-256 and size. It includes the container recipe and instructions. It has not been published.

[Infrastructure diagnosis](infra.md) records Docker’s 64 GiB configured limit, restored 2.7 GiB available capacity, host free space and a proposed owner-approved capacity increase; no configuration change or restart was performed.

## Corrigendum — 2026-09-26

The immutable submitted response uses imprecise attribution when it associates PostgreSQL SQLSTATE `53100` with the first governed database review. That governed negative report retained the failed assertion but no error detail. A subsequent direct public lifecycle diagnostic on unchanged bytes reproduced `CREATE DATABASE` SQLSTATE `53100`. The same governed Check later passed after owned-cluster cleanup. The coordinator and independent reviewer accepted this documentary correction.

An attempted corrected response resubmission was refused by the coordination extension because submitted responses are immutable. No new qualification resulted from that refusal. The original declaration was restored at revision 14 and the identical response was replayed through Runner, `COMPLETED` + `VALIDATED`, Attempt `076832ef-694c-415a-8acd-f588b459f414`. [Refusal and recovery record](helm-response-correction-refusal.json) preserves the distinction; no external SQL/history bypass occurred. Final independent observation completed with `VALIDATED`, Attempt `60db02f2-b9cf-4f2a-9d9a-93cdded830e6`; the governed delivery Plan is `COMPLETE`. At that historical completion point Kubernetes installation was unvalidated; the later successful third run is recorded separately above.
