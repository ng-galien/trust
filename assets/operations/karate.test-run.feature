# language: en
@trust-dsl:1 @operation:karate.test-run @version:1.0.0
Feature: Run one Karate test selection

  Background: Operation interface
    Given Environment
      | name          | type      |
      | workspaceRoot | directory |
    And Input
      | input        | type      | cardinality |
      | project      | reference | one         |
      | revision     | reference | one         |
      | testArgument | string    | one         |
    And Produced fields
      | field          | type      | cardinality | domain                      |
      | testedProject  | reference | one         | any                         |
      | testedRevision | reference | one         | any                         |
      | testStatus     | string    | one         | enum "successful", "failed" |

  Scenario: Run
    When Shell "test" runs "mvn" with cwd from Environment "workspaceRoot" and Input "project"
      | argument     | source               |
      | -B           | literal              |
      | test         | literal              |
      | testArgument | Input "testArgument" |
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
