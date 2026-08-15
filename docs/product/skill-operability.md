# Skill operability

## Purpose

Skill operability answers one question before an external action:

> Can this exact Skill process execute the Action Contract required by this Check now?

It does not prove that the future action or observation is true.

## Local policy

`TRUST_SKILL_POLICY=local` is the default.

The runtime admits the attempt without registry credentials, release approval, deployment selection
or announcement. The SDK still requires the Skill to implement the requested capability and exact
`actionContractDigest`. TRUST still validates every submitted Fact.

This is the normal development path.

## Verified policy

`TRUST_SKILL_POLICY=verified` adds operational controls:

1. the release is registered;
2. its manifest claims the exact `capability + actionContractDigest`;
3. the installed distribution is linked to that release;
4. the release is authorized for the environment;
5. the deployment is authorized and selected;
6. the deployment has a current announcement and passing probes;
7. runtime and process identities match the admitted caller.

If one condition is missing, TRUST refuses before the external action.

## Release manifest

A release manifest declares:

- Skill name and version;
- publisher;
- implemented `capability + actionContractDigest` pairs;
- entrypoints;
- bounded probes;
- digest of the packaged release.

It does not repeat the Fact schema and does not declare a verifier result.

## Compatibility

The Feature is the product authority for the Action Contract. The Skill release claims the digest of
the exact contract it implements. Compatibility is a direct equality check on:

```text
capability · actionContractDigest
```

Fixtures, test cases and signed `PASS` records are not part of this check.

## Availability

A deployment announcement contains:

- environment and deployment key;
- envelope;
- runtime and process identities;
- release and distribution digests;
- probe results;
- announcement and lease timestamps.

`READY` is computed from current records. It is not a persisted Skill lifecycle state and does not
block Plan engagement. It may block attempt admission under verified policy.

## Facts remain authoritative

Operability only permits an attempt. It never qualifies a Check.

After execution, TRUST validates the submitted Facts against the admitted Check and compiled Action
Contract. Missing, unknown or malformed observations reject the whole batch. Only accepted Facts can
produce `VALIDATED` or `NOT_VALIDATED`.
