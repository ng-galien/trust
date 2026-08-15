# TRUST runtime

Private current runtime containing the domain, application services, ports, infrastructure and
the target RPC, MCP, OTLP and health presentations. It must never import from `legacy/`.

The normative release scope is [TRUST V1 — minimal product scope](../../docs/product/v1-minimal-scope.md):
explicit root Plan inputs and Skills that may perform the external
effects required by their Action Contracts. TRUST validates the delegation context, then qualifies
only accepted Facts. A batch missing an observation required by the Check is rejected atomically and
leaves the Check open. Identical Facts and their resulting Snapshot, verdict and checklist delta are
deduplicated.

The current public slice exposes `GET /health`, JSON-RPC for compilation, registry,
Plan engagement, Check reads, delegation admission and finalization, plus OTLP Fact
ingestion at `POST /v1/traces`. The governed effectful roundtrip is **GO**: an external action,
absence of Facts, replay, Fact ingestion and repeated finalization are proven against the real
runtime. Public acceptance also proves semantic Fact rejection/re-observation and action precedence.
Runtime MCP is mounted at `/mcp`. Authenticated observers see the four bounded reads
`trust_procedure_read`, `trust_plan_read`, `trust_session_read` and `trust_check_read`; authenticated
operators also see `trust_plan_engage`. That operation calls the same singleton
`PlanRuntimeService` as RPC, returns semantic `ENGAGED` text plus the initial Check URIs and never
proxies an RPC DTO.

Plan engagement validates the procedure/version, Plan identifier, environment and closed root
inputs; it does not require a live Skill deployment. In the progressive path, an ephemeral Skill CLI
announces and probes its exact deployment only in `verified` policy and when the agent invokes one
returned Check URI.
With `TRUST_SKILL_POLICY=verified`, admission keeps the full fail-closed gate on release
compatibility, approval, environment selection, deployment identity and current availability before
any external action. Managed MCP
STDIO/HTTP deployments keep renewable announcements and may use the same `READY` preflight as an
optional operator policy before engagement; the advanced provisioning model is unchanged.

Public acceptance reconstructs the paginated Gherkin and reads the same Plan, Session, Check
actionability, feedback and progression exposed by the shared application services. It also proves
that an operator can engage while preflight is non-`READY`, then that the invoked CLI makes its exact
deployment available for admission. The full-Plan acceptance replaces a completed candidate
revision with a new real Git commit, observes six dependent Checks become `OPEN`, and completes the
same Plan again through the six required Bun Skill invocations. Historical Facts and Snapshots stay
immutable; the current Plan revision alone selects the qualifications that are currently good.

## Registry authority

`TRUST_SKILL_POLICY=local` is the default. It requires no credentials and skips registry,
authorization and deployment checks. `TRUST_SKILL_POLICY=verified` enables the controls below.

In `verified` policy, registry methods are denied when `TRUST_REGISTRY_PRINCIPALS_JSON` is absent.
Compilation and health remain public. The variable contains a JSON array of approved principals; each item has exactly an
absolute `identity`, bounded `roles`, a `credentialSha256` fingerprint and, for verifier roles, a
canonical Ed25519 SPKI public-key PEM. Private keys and non-canonical public encodings are refused
before the runtime starts listening. Configuration never contains a bearer credential or private
key. Identity URIs cannot contain credentials, a query or a fragment.

```json
[
  {
    "identity": "spiffe://acme.example/skill-publishers/build",
    "roles": ["publisher"],
    "credentialSha256": "sha256:<64 lowercase hex>"
  },
  {
    "identity": "spiffe://acme.example/distribution-verifiers/independent",
    "roles": ["distribution-verifier"],
    "credentialSha256": "sha256:<64 lowercase hex>",
    "publicKey": "<Ed25519 public key PEM>"
  },
  {
    "identity": "urn:uuid:<process identity>",
    "roles": ["runtime-process"],
    "credentialSha256": "sha256:<64 lowercase hex>"
  }
]
```

Each `POST /rpc` request to a registry method supplies `Authorization: Bearer <credential>`. The
runtime hashes the request credential and compares fingerprints with a timing-safe operation. It
then checks the method role and any claimed publisher, runtime or issuer identity. Distribution
records are accepted only when their Ed25519 signature verifies against the approved
principal key over deterministic canonical JSON of the complete wire record without `signature`.

Deployment announcements require two independent request-scoped proofs:

- `Authorization: Bearer <runtime credential>` authenticates `runtimeIdentity`;
- `X-Trust-Process-Authorization: Bearer <process credential>` authenticates `processIdentity`.

Every announcement also requires the `distributionDigest` of the exact installed bytes. The
deployment cannot become `READY` until an approved distribution verifier has cryptographically
linked that digest to the announced immutable `releaseDigest`.

Delegation validation, OTLP Fact export and finalization require the same two identities. This
validates and correlates the requested Check; it is not permission to act on the external system.

The process credential must be provisioned per active process and must never be shared. This keeps a
shared deployment/runtime credential from impersonating the process that currently owns the lease.
If a process credential itself is copied, the two holders are cryptographically indistinguishable;
the runtime cannot repair violated credential provisioning by inspecting a client-declared field.

The closed roles are `publisher`, `runtime`, `runtime-process`, `distribution-verifier`, `operator`
and `observer`. Producer/runtime methods remain separate from
operator authorization and selection methods; no operator operation belongs in the runner.

All behavioral tests start the built runtime and use a public boundary. There are no unit tests.
