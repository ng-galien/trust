# language: en
@trust-dsl:1 @operation:git.head-read @version:1.0.0
Feature: Invalid table

  Background: Operation interface
    Given Environment
      | variable    |
      | projectRoot |
    And Produced fields
      | field        | type      | cardinality | domain |
      | headRevision | reference | one         | any    |

  Scenario: Run
    When Shell "head" runs "git" with cwd from Environment "projectRoot"
      | argument  |
      | rev-parse |
      | HEAD      |
    Then Produce with JSONata
      """
      { "headRevision": $trim(steps.head.stdout) }
      """
