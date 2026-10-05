# language: en
@trust-dsl:1 @operation:workspace.script-gate @version:1.0.0
Feature: Run the quality gate a project declares in its own package scripts at the root of that project
  Runs the fixed script gate helper of the TRUST checkout (trust/scripts below the workspace where the projects live)
  on the project named by Input project. The gate names package scripts, never a command: each runs with npm run at the
  project root, so the project declares its own typecheck or lint commands.

  Background: Operation interface
    Given Environment
      | name | type |
      | workspaceRoot | directory |
    And Input
      | input | type | cardinality |
      | project | string | one |
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
      | trust/scripts/workspace-script-gate.mjs | literal |
      | project | Input "project" |
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
