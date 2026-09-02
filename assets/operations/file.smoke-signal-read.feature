# language: en
@trust-dsl:1 @operation:file.smoke-signal-read @version:1.0.0
Feature: Read a controlled smoke signal

  Background: Operation interface
    Given Environment
      | name          | type      |
      | workspaceRoot | directory |
    And Input
      | input          | type   | cardinality |
      | expectedSignal | string | one         |
    And Produced fields
      | field          | type   | cardinality | domain |
      | signal         | string | one         | any    |
      | expectedSignal | string | one         | any    |

  Scenario: Run
    When File "signal" reads "trust-smoke.json" as JSON from Environment "workspaceRoot"
    Then Produce with JSONata
      """
      {
        "signal": steps.signal.content.signal,
        "expectedSignal": input.expectedSignal
      }
      """
