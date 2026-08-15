# ADR 0001 — Semantic Check URI

Status: accepted product decision.

## Decision

A Check is addressed by one semantic URI:

```text
trust://<authority>[:port]/{procedure}@{version}/{plan}/{scenario}/{skill-capability}[/{expansion}...]
```

The first test environment authority is `trust-test:4318`. The approved reference URI is:

```text
trust://trust-test:4318/defect-correction@3.0.0/tk-00012/maven-verification/maven-project-verify/payment-api
```

Each segment is a canonical lowercase slug. Procedure version, Plan, Scenario, Skill capability and
semantic expansions are sufficient to derive and resolve the logical Check. A named Check uses a
Skill capability written as `domain.action` in Gherkin; that capability compiles to
`domain-action` in the URI. UUIDs, hashes, ordinals and technical segments such as `instances` or
`project` are forbidden.

The logical URI is stable. `definitionDigest` identifies the immutable compiled procedure and
`compiledCheckDigest` identifies the exact compiled Check. Digests are persisted and validated but
never form part of the public URI or normal agent output.

The authority resolves through host configuration outside the product model. Credentials and
alternate server URLs never appear in the URI, Plan or agent arguments.

Definition compilation retains URI components as structured data. Runtime materialization adds one
expansion for a fixed primary target or for the current member selected by `on each`. Singular Plan
targets and collection-wide `on all` targets add no segment. Auxiliary `using` context never changes
Check identity.

A provider's new `VALIDATED` Facts authoritatively replace the current members of its materialized
collections. When a member is omitted, the current Plan revision omits the `on each` Check whose
semantic target was that role incarnation. A `NOT_VALIDATED` qualification is not an authoritative
removal: the Check remains visible and becomes `OPEN` through dependency invalidation. An attempt
without accepted Facts creates no Plan revision, so membership and Check state remain unchanged. If
the member reappears, TRUST rematerializes the same semantic URI with its immutable history and a
new activation context.

## Acceptance rules

- compilation rejects non-canonical slugs, duplicate URIs, secrets and ambiguous expansions;
- for one procedure/version/Scenario/capability path, dynamic expansion domains are assumed to
  overlap;
  a dynamic domain also overlaps every fixed value, while distinct fixed values remain disjoint;
- `procedure@version` resolves to one immutable `definitionDigest`;
- every URI resolves exactly one Plan, Check and currently open Session;
- zero or multiple open Sessions is an explicit resolution error;
- the Skill-facing command accepts the Check URI and no other TRUST identity argument.
