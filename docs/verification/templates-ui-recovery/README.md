# Templates UI recovery acceptance

For the active authority correction, follow [the coordinator review contract](authority-review.md)
and [its Procedure](authority-procedure.feature). The current harness requires seven
review criteria, seven captures and six command results, including public architecture
acceptance. The sections below record the earlier recovery scopes; they are not the
current assignment.

## Original UI recovery

The published `templates-ui-recovery@1.0.0` Procedure verified the original recovery.
The retained sources here match its publication and the two published Operations.
The local Plan is `templates-ui-recovery-20260910` on the runtime at port 4498.
Read that live Plan before execution; use its exact Check URIs with the packaged Runner.

## Assignment and stop conditions

- Coordinator owns UI integration and source freeze. The delegated acceptance worker
  owns `apps/trust-web/acceptance/templates.acceptance.spec.ts` only.
- Require the public browser acceptance, six screenshots, and complete Code Moniker
  gate on one unchanged checkout. `scripts/templates-ui-check.mjs` records observed
  command outcomes and file digests; TRUST qualifies the resulting Facts.
- Dispatch the independent reviewer only after the interface Check is validated.
  The reviewer must inspect all six actual captures and the shared components.
  They may report issues, but must not change source or approve unseen captures.
- A rejection or missing/mismatched report must keep the review Check open.
  Do not present passing interaction tests as visual acceptance.
- Preserve unrelated changes. No shared database reset, commit, push, or product
  semantic change is authorized by this verification.

## Required screens and review criteria

| Criterion | Observable requirement | Capture |
| --- | --- | --- |
| Catalog | ResourceHome header, search, display controls and shared cards/list | catalog.png |
| Detail | ResourceOverlay header, tabs and properties inspector | detail.png |
| Editor | Shared Monaco source editor and editable parameter properties | creation.png |
| Navigation | Templates belongs to Design in expanded and compact navigation | catalog.png plus browser assertions |
| Workflow | Preview preserves Procedure source; applying changes only the draft | procedure.png plus browser assertions |
| References | Compare spacing, type, controls and surfaces with existing resources | reference-catalog.png, reference-detail.png |

Reports live outside the checkout in `/tmp/trust-consolidation-20260909`.
The reviewer writes `templates-ui-review-response.json` with `reviewer`, `decision`
(`approved` or `rejected`), `checkoutDigest`, `acceptanceDigest`, the six `captures`
digests, boolean `criteria` (`catalog`, `detail`, `editor`, `navigation`, `workflow`),
and a `findings` array. The observation Check verifies the response against the
accepted checkout and screenshot digests before TRUST qualifies it.

This Procedure verifies the recorded observations and review response. Reviewer
identity is a declared attribution, not a cryptographic authentication of an agent.

## Language assistance follow-up

`templates-language-recovery@1.0.0` (source `language-procedure.feature`) records
an additional acceptance obligation discovered after the visual recovery:
Templates must use the existing GherkinEditor and the same LSP connection and
canonical grammar analyzers as Operations and Procedures. The original UI Check
did not prove completion, semantic coloring or diagnostics.

The language worker owns the server adaptation and shared template source
mechanism; the coordinator owns editor transport integration; the acceptance
worker owns public protocol/browser tests. The verification harness additionally
runs all public LSP acceptances, the template runtime regression and the existing
browser authoring acceptances. `template-language.png` records the assisted source.
An independent review must inspect these results before completion.
