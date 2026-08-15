# language: en
@trust-dsl:1 @operation:shell.context-read @version:1.0.0
Feature: URL Shell working directory

  Background: Operation interface
    Given Environment
      | name    | type |
      | baseUrl | url  |
    And Produced fields
      | field | type   | cardinality | domain |
      | value | string | one         | any    |

  Scenario: Run
    When Shell "read" runs "pwd" with cwd from Environment "baseUrl"
      | argument |
      | -P       |
    Then Produce with JSONata
      """
      { "value": $trim(steps.read.stdout) }
      """
