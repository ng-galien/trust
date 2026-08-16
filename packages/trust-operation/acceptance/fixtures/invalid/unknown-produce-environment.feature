# language: en
@trust-dsl:1 @operation:git.head-read @version:1.0.0
Feature: Unknown Produce Environment

  Background: Operation interface
    Given Environment
      | name          | type      |
      | workspaceRoot | directory |
    And Produced fields
      | field       | type   | cardinality | domain |
      | environment | string | one         | any    |

  Scenario: Run
    When Shell "head" runs "git" with cwd from Environment "workspaceRoot"
      | argument  |
      | rev-parse |
      | HEAD      |
    Then Produce with JSONata
      """
      { "environment": environment.other }
      """
