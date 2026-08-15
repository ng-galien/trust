# language: en
@trust-dsl:1 @operation:git.head-read @version:1.0.0
Feature: Invalid produced domain

  Background: Operation interface
    Given Environment
      | name        | type |
      | projectRoot | directory |
    And Produced fields
      | field       | type   | cardinality | domain |
      | workingTree | string | one         | clean  |

  Scenario: Run
    When Shell "status" runs "git" with cwd from Environment "projectRoot"
      | argument |
      | status   |
    Then Produce with JSONata
      """
      { "workingTree": "clean" }
      """
