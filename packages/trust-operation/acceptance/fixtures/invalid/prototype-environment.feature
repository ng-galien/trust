# language: en
@trust-dsl:1 @operation:git.head-read @version:1.0.0
Feature: Prototype Environment name

  Background: Operation interface
    Given Environment
      | name          | type      |
      | workspaceRoot | directory |
    And Produced fields
      | field        | type      | cardinality | domain |
      | headRevision | reference | one         | any    |

  Scenario: Run
    When Shell "head" runs "git" with cwd from Environment "toString"
      | argument  |
      | rev-parse |
      | HEAD      |
    Then Produce with JSONata
      """
      { "headRevision": $trim(steps.head.stdout) }
      """
