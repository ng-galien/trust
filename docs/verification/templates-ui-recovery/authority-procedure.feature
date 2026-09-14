@trust-dsl:1 @procedure:templates-authority-correction @version:1.0.0
Feature: Correct templates under one canonical authority and coordinator review
  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all | Preserve structural and architectural coherence and all existing domain invariants. Correct only the five independent template review findings and the uncovered editor architecture rule. Preserve unrelated work and use existing shared UI components. One canonical authority owns template semantics; the LSP only adapts canonical behavior. Escalate uncertainty about domain semantics, ownership or scope to the coordinator before dependent work, explaining the conflict and options. The coordinator must not invent product decisions and escalates unresolved business choices to the product owner. | Take a decision outside the assigned scope, create another language or product module, make the LSP a semantic authority, weaken an invariant or acceptance, reset shared data, commit, push, fabricate observations, or self-approve the work. |
      | verify interface | The single assigned implementation agent fixes canonical template validation and literal materialization shared by runtime and LSP, compiler-owned fragment boundaries, materialized previews without recursive scanning, explicit empty defaults, obsolete MCP instructions, and editor rule coverage. Update public LSP, RPC/MCP and browser acceptance and architecture acceptance. Keep existing language analyzers, source mapping, catalog exclusion, revision checks and publication boundaries. The coordinator guards scope and verifies the frozen checkout; any doubtful correction requires coordinator escalation before implementation. | Declare design compliance from interaction test success alone, or modify the verification harness after freezing without restarting verification. |
      | review design | An independent reviewer inspects every corrected finding, canonical semantic ownership, domain invariants, public acceptance and screenshots. The coordinator is the guardian and accepts work only after independent review of the same tested checkout. Record approval or rejection, findings, checklist and the exact acceptance digest in the review response. The coordinator runs the Check that observes that response. | Implement UI changes as reviewer, approve unseen screenshots, accept a changed checkout or change the qualification to force success. |
    And one string "request" fixed as "/tmp/trust-consolidation-20260909"
  @scenario:interface
  Scenario: Verify interface behavior and produce screenshots
    Then Check "verify interface" runs Operation "templates-ui.ui@1.0.0" on "request" as Input "request" and must establish "the interface passes its public acceptance on an unchanged checkout"
      """js
      (fact.commandsSucceeded === "yes" || fail("a verification command failed")) &&
      (fact.reportParsed === "yes" || fail("the report or required screenshots are missing")) &&
      (fact.total >= 3 && fact.passed === fact.total && fact.failed === 0 && fact.skipped === 0 || fail("not every required browser acceptance passed")) &&
      (fact.beforeHead === fact.afterHead && fact.beforeDigest === fact.afterDigest || fail("the checkout changed during verification"))
      """
  @scenario:review
  Scenario: Independently review the design before completion
    Given scenario "interface" is validated
    Then Check "review design" runs Operation "templates-ui.review@1.0.0" on "request" as Input "request" and must establish "the independent design review accepts the same tested checkout and screenshots"
      """js
      (fact.commandsSucceeded === "yes" && fact.reportParsed === "yes" || fail("the review does not match the tested checkout and captures")) &&
      (fact.reviewDecision === "approved" || fail("the independent design reviewer has not approved the interface")) &&
      (fact.total >= 5 && fact.passed === fact.total && fact.failed === 0 && fact.skipped === 0 || fail("design checklist remains incomplete")) &&
      (fact.beforeHead === fact.afterHead && fact.beforeDigest === fact.afterDigest || fail("the checkout changed after review"))
      """

