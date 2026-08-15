# language: en
@trust-dsl:1 @operation:git.commit-count @version:1.0.0
Feature: Invalid number domain

  Background: Operation interface
    Given Environment
      | name        | type |
      | projectRoot | directory |
    And Produced fields
      | field       | type   | cardinality | domain        |
      | commitCount | number | one         | enum "1", "2" |

  Scenario: Run
    When Shell "count" runs "git" with cwd from Environment "projectRoot"
      | argument   |
      | rev-list   |
      | --count    |
      | --all      |
    Then Produce with JSONata
      """
      { "commitCount": $number($trim(steps.count.stdout)) }
      """
