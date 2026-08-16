# language: en
@trust-dsl:1 @operation:playwright.test-run @version:1.0.0
Feature: Run one Playwright test selection

  Background: Operation interface
    Given Environment
      | name          | type      |
      | workspaceRoot | directory |
    And Input
      | input        | type      | cardinality |
      | project      | reference | one         |
      | revision     | reference | one         |
      | testSelector | string    | one         |
    And Produced fields
      | field          | type      | cardinality | domain                      |
      | testedProject  | reference | one         | any                         |
      | testedRevision | reference | one         | any                         |
      | testStatus     | string    | one         | enum "successful", "failed" |

  Scenario: Run
    When Shell "test" runs "npx" with cwd from Environment "workspaceRoot" and Input "project"
      | argument     | source               |
      | playwright   | literal              |
      | test         | literal              |
      | testSelector | Input "testSelector" |
    And Shell "test" accepts exits
      | exit code | stdout contains | stderr contains |
      | 0         |                 |                 |
      | 1         |                 |                 |
    Then Produce with JSONata
      """
      {
        "testedProject": input.project,
        "testedRevision": input.revision,
        "testStatus": steps.test.exitCode = 0 ? "successful" : "failed"
      }
      """
