@trust-dsl:1 @procedure:templates-ui-recovery @version:1.0.0
Feature: Deliver Templates through the established TRUST interface contracts
  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all | Preserve unrelated work. Use ResourceHome, ResourceCard or ResourceTable for the catalog, ResourceOverlay for the detail, InspectorSection for properties and TrustMonacoEditor for source. Keep templates as generic reusable text. | Change product semantics, reset shared state, commit, push, weaken test assertions or fabricate observations. |
      | verify interface | Coordinator implements Templates UI. Place Templates under Design through resourceAnchors in expanded and compact navigation. Provide searchable card and list views, routable detail and creation, parameter editing, rendered preview and explicit draft application. Run public Playwright acceptance with screenshots of catalog, detail, creation and Procedure application after freezing source edits. | Declare design compliance from interaction test success alone, or modify the verification harness after freezing without restarting verification. |
      | review design | An independent reviewer inspects current screenshots and source against the existing Operations and Procedures components. Record approval or rejection, findings, checklist and the exact acceptance digest in the review response. The coordinator runs the Check that observes that response. | Implement UI changes as reviewer, approve unseen screenshots, accept a changed checkout or change the qualification to force success. |
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
