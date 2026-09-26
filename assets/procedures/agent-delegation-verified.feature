# language: en
@trust-dsl:1 @procedure:agent-delegation @version:1.1.0 @intent-chaining
Feature: Delegate a bounded mission with executed tests and independent verification
  The host launches the agent. PostgreSQL owns the mission transitions.
  Required unit, integration and database tests run before an independent reviewer repeats them.
  Reviewer identity is a procedural boundary until caller authorization is installed.

  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all | Execute the mission Operations and perform the work within the persisted authorized scope. | Expand the mission scope, change its request, impersonate another agent, or bypass the runner to write coordination state. |
      | verify unit | The assigned worker runs the exact required unit tests. | Supply an authored result or substitute test assertions. |
      | verify integration | The assigned worker runs the exact required integration tests on disposable targets. | Replace public integration assertions with mock or superficial checks. |
      | verify database | The assigned worker runs the exact required database tests on disposable databases. | Touch retained data or substitute mock database assertions. |
      | review unit | Only the named independent reviewer inspects the assertions and source closure, then reruns the unit group. | The worker performs its own independent review or changes assertions to obtain a pass. |
      | review integration | Only the named independent reviewer inspects public integration assertions and reruns the group. | The worker performs its own independent review or substitutes fabricated service responses. |
      | review database | Only the named independent reviewer inspects database assertions and reruns the group. | The worker performs its own independent review or uses retained databases as fixtures. |
    And one string "mission"
    And one string "assignee"
    And one string "project"
    And one string "instructions"
    And one string "expected"
    And one string "authorized"
    And one string "forbidden"
    And one string "reviewer"
    And one string "unit verification"
    And one string "integration verification"
    And one string "database verification"
    And one string "unit layer" fixed as "unit"
    And one string "integration layer" fixed as "integration"
    And one string "database layer" fixed as "database"
    And one string "capture digest" fixed as "capture"
    And one string "unit digest"
    And one string "integration digest"
    And one string "database digest"
    And one string "response" declared by agent
    And one string "outcome" declared by agent

  @scenario:creation
  Scenario: Persist the mission before dispatch
    Then Check "create mission" runs Operation "coordination.mission-create@*"
      on "mission" as Input "mission"
      using plan as Input "plan"
      using "assignee" as Input "assignee"
      using "project" as Input "project"
      using "instructions" as Input "instructions"
      using "expected" as Input "expected"
      using "authorized" as Input "authorized"
      using "forbidden" as Input "forbidden"
      and must establish "the exact mission is stored"
      """js
      fact.mission === context.mission && fact.assignee === context.assignee ||
      fail("the database did not return the assigned mission")
      """

  @scenario:claim
  Scenario: Take responsibility for the mission
    Given scenario "creation" is validated
    Then Check "claim mission" runs Operation "coordination.mission-claim@*"
      on "mission" as Input "mission"
      using "assignee" as Input "actor"
      and must establish "the assigned agent owns the mission"
      """js
      fact.owner === context.assignee && fact.state === "claimed" ||
      fail("the assigned agent has not claimed the mission")
      """

  @scenario:verification
  Scenario: Execute required tests
    Given scenario "claim" is validated
    Then Check "verify unit" runs Operation "coordination.verification-run@1.0.0"
      on "unit verification" as Input "contract"
      using "unit layer" as Input "layer"
      using "capture digest" as Input "expectedDigest"
      and materializes "unit digest" from field "sourceDigest"
      and must establish "the required unit assertions executed successfully"
      """js
      (fact.complete === 1 && fact.tested > 0 && fact.passed > 0 && fact.failed === 0 && fact.skipped === 0 && fact.crashed === 0 && fact.missing === 0 && fact.stale === 0 && fact.sourceDigest === fact.afterDigest) ||
      fail("required assertions are absent, failed, skipped, crashed or refer to stale code")
      """
    Then Check "verify integration" runs Operation "coordination.verification-run@1.0.0"
      on "integration verification" as Input "contract"
      using "integration layer" as Input "layer"
      using "capture digest" as Input "expectedDigest"
      and materializes "integration digest" from field "sourceDigest"
      and must establish "the required integration assertions executed successfully"
      """js
      (fact.complete === 1 && fact.tested > 0 && fact.passed > 0 && fact.failed === 0 && fact.skipped === 0 && fact.crashed === 0 && fact.missing === 0 && fact.stale === 0 && fact.sourceDigest === fact.afterDigest) ||
      fail("required assertions are absent, failed, skipped, crashed or refer to stale code")
      """
    Then Check "verify database" runs Operation "coordination.verification-run@1.0.0"
      on "database verification" as Input "contract"
      using "database layer" as Input "layer"
      using "capture digest" as Input "expectedDigest"
      and materializes "database digest" from field "sourceDigest"
      and must establish "the required database assertions executed successfully"
      """js
      (fact.complete === 1 && fact.tested > 0 && fact.passed > 0 && fact.failed === 0 && fact.skipped === 0 && fact.crashed === 0 && fact.missing === 0 && fact.stale === 0 && fact.sourceDigest === fact.afterDigest) ||
      fail("required assertions are absent, failed, skipped, crashed or refer to stale code")
      """

  @scenario:review
  Scenario: Independently inspect and repeat the required tests
    Given scenario "verification" is validated
    Then Check "review unit" runs Operation "coordination.verification-run@1.0.0"
      on "unit verification" as Input "contract"
      using "unit layer" as Input "layer"
      using "unit digest" as Input "expectedDigest"
      and must establish "the required unit assertions executed successfully again on the same code"
      """js
      (fact.complete === 1 && fact.tested > 0 && fact.passed > 0 && fact.failed === 0 && fact.skipped === 0 && fact.crashed === 0 && fact.missing === 0 && fact.stale === 0 && fact.sourceDigest === fact.afterDigest && fact.sourceDigest === context["unit digest"] && context.reviewer !== context.assignee) ||
      fail("required assertions are absent, failed, skipped, crashed or refer to stale code")
      """
    Then Check "review integration" runs Operation "coordination.verification-run@1.0.0"
      on "integration verification" as Input "contract"
      using "integration layer" as Input "layer"
      using "integration digest" as Input "expectedDigest"
      and must establish "the required integration assertions executed successfully again on the same code"
      """js
      (fact.complete === 1 && fact.tested > 0 && fact.passed > 0 && fact.failed === 0 && fact.skipped === 0 && fact.crashed === 0 && fact.missing === 0 && fact.stale === 0 && fact.sourceDigest === fact.afterDigest && fact.sourceDigest === context["integration digest"] && context.reviewer !== context.assignee) ||
      fail("required assertions are absent, failed, skipped, crashed or refer to stale code")
      """
    Then Check "review database" runs Operation "coordination.verification-run@1.0.0"
      on "database verification" as Input "contract"
      using "database layer" as Input "layer"
      using "database digest" as Input "expectedDigest"
      and must establish "the required database assertions executed successfully again on the same code"
      """js
      (fact.complete === 1 && fact.tested > 0 && fact.passed > 0 && fact.failed === 0 && fact.skipped === 0 && fact.crashed === 0 && fact.missing === 0 && fact.stale === 0 && fact.sourceDigest === fact.afterDigest && fact.sourceDigest === context["database digest"] && context.reviewer !== context.assignee) ||
      fail("required assertions are absent, failed, skipped, crashed or refer to stale code")
      """

  @scenario:response
  Scenario: Persist the agent response
    Given scenario "review" is validated
    Then Check "submit response" runs Operation "coordination.mission-submit@*"
      on "mission" as Input "mission"
      using "assignee" as Input "actor"
      using "response" as Input "response"
      using "outcome" as Input "outcome"
      and must establish "the owner response is stored"
      """js
      fact.owner === context.assignee && fact.response === context.response ||
      fail("the database did not persist the owner response")
      """

  @scenario:completion
  Scenario: Observe the declared completion
    Given scenario "response" is validated
    Then Check "observe completion" runs Operation "coordination.mission-read@*"
      on "mission" as Input "mission"
      and must establish "the assigned agent returned a completed response"
      """js
      fact.owner === context.assignee && fact.state === "completed" ||
      fail("the agent reported a blocker; escalate instead of declaring completion")
      """
