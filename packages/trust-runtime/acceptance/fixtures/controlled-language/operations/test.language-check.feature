# language: en
@trust-dsl:1 @operation:test.language-check @version:1.0.0
Feature: Observe one declared request for controlled language acceptance

  Background: Operation interface
    Given Environment
      | name          | type      |
      | workspaceRoot | directory |
    And Input
      | input   | type   | cardinality |
      | request | string | one         |
    And Produced fields
      | field     | type   | cardinality | domain |
      | completed | string | one         | any    |

  Scenario: Run
    When Shell "observe" runs "node" with cwd from Environment "workspaceRoot"
      | argument | source  |
      | --version | literal |
    Then Produce with JSONata
      """
      { "completed": "yes" }
      """
