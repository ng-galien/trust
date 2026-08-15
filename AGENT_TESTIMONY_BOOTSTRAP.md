# Agent testimony infrastructure bootstrap

This temporary file records the installation and live-verification contract for
TRUST agent testimony collection. Keep it in the repository until both the pull
request gate and the direct-`main` workflow have produced live evidence.

## Scope

- Install infrastructure only. Do not request, propose, write, or submit an
  agent testimony during this bootstrap.
- Do not trigger either collection workflow and do not create a test pull
  request. Only the user may explicitly request a testimony later.
- Do not modify TRUST product code.
- Collection workflows may only open or update a collection pull request in
  `ng-galien/ng-galien.github.io`. They must never publish or merge blog content.

## Repository contract

- Repository: `ng-galien/trust`
- Source branch: `main`
- Project slug: `trust`
- Project label: `TRUST`
- Categories: `["Agents", "TRUST"]`
- Tags: `["agent-testimony", "trust"]`
- GitHub App repository variable: `BLOG_APP_ID=4594668`
- GitHub App repository secret name: `BLOG_APP_PRIVATE_KEY`

## Installed files

- `.github/pull_request_template.md` contains the French editorial invitation
  and exactly one `agent-testimony:start` / `agent-testimony:end` marker pair.
- `.github/workflows/agent-testimony.yml` delegates pull request collection to
  `ng-galien/ng-galien.github.io/.github/workflows/collect-agent-testimony.yml@main`.
- `.github/workflows/agent-testimony-main.yml` delegates manual collection from
  `main` to
  `ng-galien/ng-galien.github.io/.github/workflows/collect-agent-testimony-main.yml@main`.

## Installation verification

- Validate both YAML files.
- Confirm there are no placeholders.
- Confirm the exact TRUST metadata in both workflows.
- Confirm both reusable blog workflows exist on `main`.
- Confirm `BLOG_APP_ID` exists with value `4594668`.
- Confirm the repository secret name `BLOG_APP_PRIVATE_KEY` exists without ever
  printing its value.
- Confirm the committed diff is limited to this bootstrap file and `.github`.

## Live verification still required

Do not remove this file after installation. Remove it only after a later,
explicit user request has exercised and verified both paths:

1. a real, non-draft TRUST pull request runs the pull request gate and creates
   or updates the expected collection pull request in the blog repository;
2. an explicit manual dispatch from TRUST `main` creates or updates the expected
   collection pull request in the blog repository.

Neither live path is part of this infrastructure-only installation.
