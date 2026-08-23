# language: en
@trust-dsl:1 @operation:shell.additional-path @version:1.0.0
Feature: Execute a command discovered through the configured runner path

  Background: Operation interface
    Given Environment
      | name          | type      |
      | workspaceRoot | directory |
    And Produced fields
      | field  | type   | cardinality | domain |
      | output | string | one         | any    |

  Scenario: Run
    When Shell "probe" runs "trust-path-probe" with cwd from Environment "workspaceRoot"
      | argument |
      | ready    |
    Then Produce with JSONata
      """
      { "output": $trim(steps.probe.stdout) }
      """
