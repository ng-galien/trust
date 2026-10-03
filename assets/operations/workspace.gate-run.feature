# language: en
@trust-dsl:1 @operation:workspace.gate-run @version:1.0.0
Feature: Run one closed quality gate of a delegated mission on the current checkout
  Runs the fixed workspace gate helper; the gate names a fixed command set, never an agent-authored command.

  Background: Operation interface
    Given Environment
      | name | type |
      | workspaceRoot | directory |
    And Input
      | input | type | cardinality |
      | gate | string | one |
    And Produced fields
      | field | type | cardinality | domain |
      | gate | string | one | any |
      | passed | number | one | any |
      | findings | number | one | any |
      | summary | string | one | any |

  Scenario: Run
    When Shell "gate" runs "node" with cwd from Environment "workspaceRoot"
      | argument | source |
      | scripts/workspace-gate.mjs | literal |
      | gate | Input "gate" |
    Then Produce with JSONata
      """
      {
        "gate": $split(steps.gate.stdout, "\n")[0],
        "passed": $number($split(steps.gate.stdout, "\n")[1]),
        "findings": $number($split(steps.gate.stdout, "\n")[2]),
        "summary": $split(steps.gate.stdout, "\n")[3]
      }
      """
