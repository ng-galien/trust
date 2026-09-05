# Resource versioning

Status: approved direction; implementation and public acceptance in progress.

## Product decisions

- Procedures and Operations have one identity with multiple immutable published versions.
- DSL references use the npm-style `name@selector` form. Exact versions and standard
  node-semver ranges are supported; no custom `latest` alias is introduced.
- A new root Plan resolves its entire recursive dependency composition and pins the
  exact selected definitions. Children that start later use this same selection.
- Existing Plans do not adopt new publications, including during resumption or child
  generation replacement.
- Compatibility checks remain mandatory: Inputs, types, cardinalities, observations,
  Action Contracts and dependency cycles. Selecting an incompatible highest matching
  version fails explicitly; it must not silently choose an older compatible candidate.
- SemVer is the author's compatibility commitment, not proof of behavioral equivalence.
- The UI groups each resource identity once; its versions are selected within the detail
  view. Historical exact-version links remain navigable.
- Published source cannot be edited in place. Draft edits produce a new version.
- Published Procedure and Operation versions cannot be deleted, including unused or
  highest versions. Discarding an unpublished draft is a separate action.

## Implementation boundaries

Keep the requested selector separate from the exact resolved dependency identity and
definition. Publication remains immutable even when a referenced selector can resolve
differently for a later Plan. Compilation and engagement must distinguish their resolution
context explicitly; never rewrite a published Procedure just to update its dependencies.

The Operation save hotfix rejects both an existing identity/version and an occupied
source filename. Registry imports reject modified versions before mutation. Published
Operation removal is refused at the shared server boundary; no Procedure removal API
is exposed. Preserve the live Dragon Heist data during implementation.

## Public acceptance matrix

- Exact versions and standard ranges, numeric precedence, prereleases and major-zero rules.
- No match, malformed selector and incompatible highest match are explicit refusals.
- Three- and four-level composition, shared descendants and cycles after resolution.
- Publication before engagement changes a floating selection; publication after engagement
  does not change root Checks or children that have not yet started.
- Restart, escalation/resume and invalidation preserve the Plan's pinned composition.
- Concurrent publication cannot produce a mixed or partially pinned composition.
- Same-version replacement is refused through every supported mutation surface.
- Resource grouping, exact-version selection, source editing, new-version publication,
  retained filters and navigation back to the origin work through the real browser.

## References

- https://semver.org/
- https://github.com/npm/node-semver#ranges
- https://docs.npmjs.com/cli/v11/using-npm/package-spec/

SemVer defines version precedence and compatibility commitments. npm/node-semver supplies
the selector syntax and range behavior; these are related but distinct conventions.
