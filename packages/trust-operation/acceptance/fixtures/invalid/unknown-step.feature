# language: en
@trust-dsl:1 @operation:git.head-read @version:1.0.0
Feature: Unknown step

  Background: Operation interface
    Given Environment
      | name          | type      |
      | workspaceRoot | directory |
    And Produced fields
      | field        | type      | cardinality | domain |
      | headRevision | reference | one         | any    |

  Scenario: Run
    When Command "head" runs "git"
    Then Produce with JSONata
      """
      { "headRevision": "unknown" }
      """
