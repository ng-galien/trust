# language: en
@trust-dsl:1 @procedure:integration-test @version:1.0.0
Feature: Run one integration test and confirm its trace markers

  Runs one Karate integration test against a project revision and confirms, through the
  OpenTelemetry trace it emits, that the expected markers were observed end to end.

  Background: Plan context
    Given one reference "test project"
    And one reference "test revision" for "test project"
    And one string "test argument" declared by agent for "test project"
    And one reference "trace"

  @scenario:test
  Scenario: Run the integration test
    Then Check "integration test" runs Operation "karate.test-run" on "test project" as Input "project" using "test revision" as Input "revision" using "test argument" as Input "testArgument" and must establish "the integration test succeeds"
      | field          | relation | expectation             | failure reason                    |
      | testedRevision | equals   | context "test revision" | "the test ran on another revision" |
      | testStatus     | equals   | value "successful"       | "the integration test failed"      |
    And the Scenario is satisfied when every Check is validated

  @scenario:trace
  Scenario: Confirm the integration trace marker
    Given scenario "test" is validated
    Then Check "trace marker" runs Operation "telemetry.trace-read" on "trace" as Input "traceId" and must establish "the integration trace contains a marker"
      | field       | relation | expectation | failure reason                        |
      | markerCount | at least | number 1    | "the integration trace has no marker" |
    And the Scenario is satisfied when every Check is validated
