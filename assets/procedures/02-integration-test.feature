# language: en
@trust-dsl:1 @procedure:integration-test @version:1.0.0
Feature: Run one integration test and confirm its trace markers

  Runs one Karate integration test against a project revision and confirms, through the
  OpenTelemetry trace it emits, that the expected markers were observed end to end.

  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all   | Run the declared integration test and observe its emitted trace. | Alter telemetry collection or the runtime environment to manufacture the expected observations. |
    Given one reference "test project"
    And one reference "test revision" for "test project"
    And one string "test argument" declared by agent for "test project"
    And one reference "trace"

  @scenario:test
  Scenario: Run the integration test
    Then Check "integration test" runs Operation "karate.test-run" on "test project" as Input "project" using "test revision" as Input "revision" using "test argument" as Input "testArgument" and must establish "the integration test succeeds"
      """js
      (
        fact.testedRevision === context["test revision"] ||
        fail("the test ran on another revision")
      ) &&
      (
        fact.testStatus === "successful" ||
        fail("the integration test failed")
      )
      """

  @scenario:trace
  Scenario: Confirm the integration trace marker
    Given scenario "test" is validated
    Then Check "trace marker" runs Operation "telemetry.trace-read" on "trace" as Input "traceId" and must establish "the integration trace was recorded"
      """js
      fact.spanCount >= 1 ||
      fail("the integration trace has no span")
      """
