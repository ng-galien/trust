# Trust Kind Test environment

This directory defines the local operational test environment used to exercise the ticket-resolution flow under realistic conditions.

The test environment is intentionally small, but it keeps the same shape as the target workflow:

- `trust-test` namespace for business services and connector integrations;
- `telemetry` namespace for OpenTelemetry and Tempo;
- Postgres as a stateful dependency for sample services;
- Pulsar as the asynchronous broker for cross-service domain events;
- one shared Java library, three Spring Boot services and one Karate acceptance suite under the
  sibling `trust-projects/` workspace;
- OpenTelemetry propagation through `traceparent` and `baggage`, including `tr-audit-feat`, `tr-audit-run`, `tr-audit-phase` and `tr-audit-branch`.
- Java trace instrumentation for HTTP, JDBC, selected methods and Pulsar links.

## Layout

```text
k8s/
  cluster/              Kind cluster config
  k8s/                  Kubernetes manifests applied with kubectl/kustomize
  scripts/              Local helper scripts
../trust-projects/
  payment-common/       Independent Git checkout for the shared DTO JAR
  payment-api/          Independent Git checkout for the Spring Boot entry service
  payment-worker/       Independent Git checkout for the downstream service
  event-store/          Independent Git checkout for the Pulsar consumer
  payment-acceptance/   Independent Git checkout for the Karate acceptance suite
```

Each directory under `../trust-projects` is a standalone repository whose `origin` targets the
matching project below `trustgroup/trust-devs` in the test environment GitLab. These repositories live outside
the TRUST checkout. The Environment references their locations without owning their files or Git
history.

## Intended Usage

Create the cluster:

```bash
k8s/scripts/up.sh
```

This creates or updates the Kind cluster, installs `ingress-nginx` when needed, then applies the test environment manifests.

The test environment uses the connector integration profile:

```bash
k8s/scripts/up.sh integration
k8s/scripts/build-connectors.sh
k8s/scripts/seed-gitlab.sh
k8s/scripts/wire-gitlab-jenkins-hooks.sh
```

The integration profile keeps the same Spring Boot sample services and telemetry stack, then adds:

- GitLab CE at `http://gitlab.127.0.0.1.nip.io`;
- Jenkins at `http://jenkins.127.0.0.1.nip.io`;
- a Spring Boot Jira mock at `http://jira.127.0.0.1.nip.io`.

Trust remains an independent consumer of those connector endpoints.

## Integration Profile Registry

This section is the human-readable registry for the real connector profile. The executable sources of truth are:

| Area | Source |
| --- | --- |
| Kubernetes services, secrets, Jenkins JCasC jobs | `k8s/k8s/integration/connectors.yaml` |
| GitLab group and empty-project provisioning | `k8s/scripts/seed-gitlab.sh` |
| GitLab CI disable/prune helper | `k8s/scripts/disable-gitlab-ci.sh` |
| GitLab push hooks to Jenkins | `k8s/scripts/wire-gitlab-jenkins-hooks.sh` |
| Spring Boot Jira mock default issues | `k8s/connectors/jira-mock/src/main/java/dev/trust/jiramock/JiraMockController.java` |

### Connector Access

These credentials are local test environment fixtures only; they are checked into the Kind test environment manifests so the environment can be recreated deterministically.

| Connector | Browser/API URL | In-cluster URL | Local credential |
| --- | --- | --- | --- |
| GitLab | `http://gitlab.127.0.0.1.nip.io` | `http://gitlab.trust-test.svc.cluster.local` | user `root`; password `qK7!vR2@zM9#tP4%wX8`; API token `local-gitlab-token` |
| Jenkins | `http://jenkins.127.0.0.1.nip.io` | `http://jenkins.trust-test.svc.cluster.local:8080` | user `admin`; password `local-jenkins-token`; build token `local-jenkins-build-token` |
| Jira mock | `http://jira.127.0.0.1.nip.io` | `http://jira-mock.trust-test.svc.cluster.local:8080` | no auth in the local test environment |

Use the browser URLs from the host. Use the in-cluster URLs from Jenkins jobs, pods and GitLab webhooks. In particular, Jenkins must clone GitLab through `gitlab.trust-test.svc.cluster.local`; `gitlab.127.0.0.1.nip.io` resolves to the caller pod loopback inside Kubernetes.

### Authentication Coverage

The test environment is the functional test bed for TRUST connector authentication — one mode per target
service, no full matrix:

| Auth mode | Target service | How it is exercised |
| --- | --- | --- |
| `static` token header (`pat` scheme) | GitLab | `kind-integration` seed selects `pat` with `values.token` |
| `static` Basic, platform-encoded (`apitoken` scheme) | Jenkins | seed selects `apitoken` with `username`/`apiToken`; no hand-encoded base64 |
| `oauth2` authorization code + PKCE (`sso` scheme) | GitLab | `seed-gitlab.sh` registers the public OAuth application `trust-local` (trusted, redirect `http://127.0.0.1:8085/api/auth/callback`); select the `sso` scheme in the Datasource inspector and sign in as `root` |
| legacy `credentials.headers` | Tempo, Jira mock | unchanged entries keep the raw-header path covered |

GitLab doubles as the OAuth authorization server (its native OIDC provider); no extra identity
component runs in the test environment.

### Jira Mock Tickets

The Spring Boot Jira mock persists its state in the `jira-mock-data` PVC. The default issues are inserted only when the SQLite database is empty.

| Ticket | Default status | Priority | Purpose |
| --- | --- | --- | --- |
| `TK-00001` | `In Progress` | `High` | Create payment link audit trail; exercises GitLab, Jenkins, Jira comments and transitions. |
| `TK-00002` | `To Do` | `Medium` | Verify asynchronous payment event evidence and sprint aggregation. |
| `TK-00003` | `In Progress` | `Medium` | Ticket intentionally missing runtime evidence. |
| `TK-00004` | `In Progress` | `High` | Payment link response must expose `expiresAt`. |
| `TK-00005` | `In Progress` | `High` | Payment link response must expose `auditLabel`. |
| `TK-00006` | `In Progress` | `High` | Payment flow must expose stored event status across `payment-api` and `event-store`. |

Useful Jira mock endpoints:

```text
GET  http://jira.127.0.0.1.nip.io/
GET  http://jira.127.0.0.1.nip.io/rest/api/2/myself
GET  http://jira.127.0.0.1.nip.io/rest/api/3/search/jql?jql=...
GET  http://jira.127.0.0.1.nip.io/rest/api/3/issue/TK-00005
POST http://jira.127.0.0.1.nip.io/__admin/reset
```

The `/` page is a small Thymeleaf ticket console for humans. It supports ticket creation, selection, editing, status changes, comments and deletion. The REST surface stays Jira-compatible for Trust and integration tests.

Ticket creation always assigns the next `TK-000NN` key from persisted issues. A key provided in the create payload is ignored deliberately so tests exercise the mock as the ticket id authority. Loose keys are normalized before lookup or mutation: `7`, `tk-7`, `TK0007` and `TK-00007` all resolve to `TK-00007`.

Useful mutation calls for integration tests:

```bash
curl -sS -X POST http://jira.127.0.0.1.nip.io/__admin/issues \
  -H 'content-type: application/json' \
  -d '{"summary":"Integration smoke ticket","description":"Created by the test environment smoke flow.","status":"To Do","assignee":"Mock Trust User","priority":"Medium"}'

curl -sS -X PUT http://jira.127.0.0.1.nip.io/__admin/issues/7 \
  -H 'content-type: application/json' \
  -d '{"summary":"Edited integration smoke ticket","priority":"High"}'

curl -sS -X POST http://jira.127.0.0.1.nip.io/rest/api/3/issue/TK-00007/comment \
  -H 'content-type: application/json' \
  -d '{"body":"Smoke comment added through the Jira-compatible API."}'

curl -sS -X POST http://jira.127.0.0.1.nip.io/rest/api/3/issue/TK-00007/transitions \
  -H 'content-type: application/json' \
  -d '{"transition":{"id":"11"}}'

curl -sS -X DELETE http://jira.127.0.0.1.nip.io/rest/api/3/issue/TK-00007
```

The connector has a Spring Boot integration test that covers the CRUD page, create, edit, comment, transition and delete:

```bash
mvn -f k8s/connectors/jira-mock/pom.xml -B test
```

### GitLab Projects And Branches

The GitLab namespace is `trustgroup/trust-devs`.

| Project | Branches expected in GitLab | Jenkins hooks |
| --- | --- | --- |
| `payment-common` | `main`, `develop`, `feature/TK-00001-runtime-anchor` | multibranch job `payment-common` |
| `payment-api` | `main`, `develop`, `feature/TK-00001-runtime-anchor`, `bugfix/TR-00005-payment-link-audit-label` | multibranch job `payment-api` |
| `payment-worker` | `main`, `develop`, `feature/TK-00001-runtime-anchor` | multibranch job `payment-worker` |
| `event-store` | `main`, `develop`, `feature/TK-00001-runtime-anchor` | multibranch job `event-store` |
| `kind-test` | `main`, `develop` | none; this is the infra repository |

Host clone URL pattern:

```text
http://gitlab.127.0.0.1.nip.io/trustgroup/trust-devs/<project>.git
```

In-cluster clone URL pattern used by Jenkins:

```text
http://gitlab.trust-test.svc.cluster.local/trustgroup/trust-devs/<project>.git
```

### Jenkins Jobs And Hooks

Jenkins multibranch jobs are generated by JCasC in `k8s/k8s/integration/connectors.yaml`.
Each project repository supplies the test environment `Jenkinsfile`; Jenkins discovers branches and then runs:

```text
mvn -B -DskipTests validate
mvn -B -DskipTests package
```

The service repositories also build `payment-common` from `main` first so the shared DTO JAR is available in the Jenkins workspace.

GitLab CI pipelines are disabled for the test environment projects. GitLab Auto DevOps is turned off by
`k8s/scripts/seed-gitlab.sh`. That script never reads or mutates local repositories and
never pushes Git content. Branches, commits and merge requests are created only by explicit
developer or StateMachine workflows. Existing GitLab pipeline records can be removed with:

```bash
k8s/scripts/disable-gitlab-ci.sh
```

Jenkins is the CI source of truth in this test environment. Each Jenkins job publishes a GitLab commit status named `jenkins/<job-name>` through the GitLab statuses API. GitLab therefore shows Jenkins build state on commits without running native GitLab CI jobs or requiring a GitLab Runner.

GitLab push hooks are installed by `k8s/scripts/wire-gitlab-jenkins-hooks.sh`. Each project
hook notifies Jenkins that the matching multibranch repository must be rescanned:

```text
http://jenkins.trust-test.svc.cluster.local:8080/git/notifyCommit?url=<repository-url>
```

The hook has `push_events=true` and a branch filter matching the branch in the project table above.

### Quick Verification

```bash
kubectl -n trust-test get deploy gitlab jenkins jira-mock

curl -sS --header 'PRIVATE-TOKEN: local-gitlab-token' \
  http://gitlab.127.0.0.1.nip.io/api/v4/projects/trustgroup%2Ftrust-devs%2Fpayment-api/repository/branches

curl -g -sS -u admin:local-jenkins-token \
  'http://jenkins.127.0.0.1.nip.io/api/json?tree=jobs[name,color,lastBuild[number,result]]'

curl -sS http://jira.127.0.0.1.nip.io/rest/api/3/issue/TK-00005
```

Build and load the sample services:

```bash
k8s/scripts/build-samples.sh
```

Use the Ingress endpoints as the default test environment addresses:

| Host | Service | Purpose |
| --- | --- | --- |
| `http://payment-api.127.0.0.1.nip.io` | `payment-api` | Entry point for the sample payment flow. |
| `http://payment-worker.127.0.0.1.nip.io` | `payment-worker` | Downstream HTTP worker, useful for direct probes. |
| `http://event-store.127.0.0.1.nip.io` | `event-store` | Persisted async events, for example `/events?run=run-local`. |
| `http://jira.127.0.0.1.nip.io` | `jira-mock` | Persistent Jira REST subset in the integration profile. |
| `http://gitlab.127.0.0.1.nip.io` | `gitlab` | GitLab CE in the integration profile. |
| `http://jenkins.127.0.0.1.nip.io` | `jenkins` | Jenkins LTS in the integration profile. |
| `http://tempo.127.0.0.1.nip.io` | `tempo` | Tempo query API, for example `/api/v2/traces/{traceId}`. |
| `http://otel-collector.127.0.0.1.nip.io` | `otel-collector` | OTLP HTTP receiver used by the host TRUST runtime. |
| `http://pulsar-admin.127.0.0.1.nip.io` | `pulsar` | Pulsar HTTP admin endpoint. |

`nip.io` resolves the embedded IP address in the hostname, so every `*.127.0.0.1.nip.io` host resolves to local loopback without editing `/etc/hosts`.

Port forwarding remains available as a fallback:

```bash
k8s/scripts/port-forward.sh
```

Then generate a traceable run:

```bash
curl -s http://payment-api.127.0.0.1.nip.io/payment-links \
  -H 'content-type: application/json' \
  -H 'traceparent: 00-11111111111111111111111111111111-2222222222222222-01' \
  -H 'baggage: tr-audit-feat=TK-00001,tr-audit-run=run-local,tr-audit-phase=01-create-payment-link,tr-audit-branch=feature/TK-00001-payment-link' \
  -d '{"amount": 42, "currency": "EUR"}'
```

The event-store read model is available through Ingress at
`http://event-store.127.0.0.1.nip.io/events?run=run-local`.

The Jira integration mock persists its dynamic issue, comment and transition state in SQLite at `/data/jira-mock.sqlite` on the `jira-mock-data` PVC. The default scenario is seeded only when the database is empty; use `POST /__admin/reset` to reset it deliberately.

The GitLab deployment is deliberately memory-constrained for local use. The Omnibus config disables bundled monitoring/exporters, registry, Pages, Mattermost, KAS and CI database splitting, runs Puma in single mode, lowers Puma threads, and keeps Sidekiq concurrency low. This trades throughput for a smaller local footprint, which is acceptable for connector-contract validation.

Tempo and the OTLP collector are exposed through Ingress as:

- `http://tempo.127.0.0.1.nip.io`
- `http://otel-collector.127.0.0.1.nip.io`
- `pulsar://127.0.0.1:16650`

## OpenTelemetry Reference

The test environment exports traces only. Java services send OTLP HTTP traces to the collector;
the collector normalizes resource and HTTP attributes, applies tail sampling, and stores traces in
Tempo. Log and metric exporters are disabled. Only stable Java agent options are enabled.

The stable configuration is defined by:

- `k8s/k8s/sample-services.yaml` for Java trace instrumentation;
- `k8s/k8s/telemetry.yaml` for OTLP collection, sampling, and Tempo storage.

## Design Notes

The MCP should not own this environment. The agent runs commands, tests, acceptance flows and fixes code. The environment exists so the MCP can validate that operational evidence exists and that external-resource state is coherent with the current resolution stage.

The old NodePort and port-forward endpoints remain as a convenience fallback, but the canonical local addresses are the `nip.io` Ingress hosts.
