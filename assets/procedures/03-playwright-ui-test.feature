# language: en
@trust-dsl:1 @procedure:playwright-ui-test @version:1.0.0
Feature: Run one Playwright user-interface test

  Background: Plan context
    Given one reference "web project"
    And one reference "web revision" for "web project"
    And one string "test selector" declared by agent for "web project"

  @scenario:test
  Scenario: Run the selected Playwright test
    Then Check "Playwright test" runs Operation "playwright.test-run" on "web project" as Input "project" using "web revision" as Input "revision" using "test selector" as Input "testSelector" and must establish "the selected user-interface behavior succeeds"
      | field          | relation | expectation            | failure reason                     |
      | testedRevision | equals   | context "web revision" | "Playwright used another revision"  |
      | testStatus     | equals   | value "successful"      | "the Playwright test failed"        |
    And the Scenario is satisfied when every Check is validated
