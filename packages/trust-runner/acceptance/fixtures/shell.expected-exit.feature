# language: en
@trust-dsl:1 @operation:shell.expected-exit @version:1.0.0
Feature: Observe one expected non-zero exit

  Background: Operation interface
    Given Environment
      | name        | type      |
      | projectRoot | directory |
    And Produced fields
      | field    | type   | cardinality | domain |
      | exitCode | number | one         | any    |

  Scenario: Run
    When Shell "command" runs "node" with cwd from Environment "projectRoot"
      | argument        | source  |
      | -e              | literal |
      | process.stdout.write("Tests run: 1"); process.exit(1) | literal |
    And Shell "command" accepts exits
      | exit code | stdout contains | stderr contains |
      | 1         | Tests run:      |                 |
    Then Produce with JSONata
      """
      { "exitCode": steps.command.exitCode }
      """
