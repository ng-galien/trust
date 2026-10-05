# language: en
@trust-dsl:1 @operation:delegation.topology-check @version:1.0.0
Feature: Check a delegation topology of the workspace with Icarus Verilog
  Runs the fixed topology check helper on one topology file written with the delegation library: wiring, then a simulated
  run. Input missions names the data file giving each mission's remaining root inputs, or "none". Produces the verdict,
  the stage and the reason, and for an accepted topology the missions, owner decisions, delivery and mission structure
  to declare in a Plan, each as a JSON array.

  Background: Operation interface
    Given Environment
      | name | type |
      | workspaceRoot | directory |
    And Input
      | input | type | cardinality |
      | topology | string | one |
      | missions | string | one |
    And Produced fields
      | field | type | cardinality | domain |
      | topology | string | one | any |
      | accepted | number | one | any |
      | stage | string | one | any |
      | reason | string | one | any |
      | missions | string | one | any |
      | decisions | string | one | any |
      | delivery | string | one | any |
      | structure | string | one | any |

  Scenario: Run
    When Shell "check" runs "node" with cwd from Environment "workspaceRoot"
      | argument | source |
      | scripts/delegation-topology.mjs | literal |
      | check | literal |
      | topology | Input "topology" |
      | --missions | literal |
      | missions | Input "missions" |
      | --lines | literal |
    Then Produce with JSONata
      """
      {
        "topology": $split(steps.check.stdout, "\n")[0],
        "accepted": $number($split(steps.check.stdout, "\n")[1]),
        "stage": $split(steps.check.stdout, "\n")[2],
        "reason": $split(steps.check.stdout, "\n")[3],
        "missions": $split(steps.check.stdout, "\n")[4],
        "decisions": $split(steps.check.stdout, "\n")[5],
        "delivery": $split(steps.check.stdout, "\n")[6],
        "structure": $split(steps.check.stdout, "\n")[7]
      }
      """
