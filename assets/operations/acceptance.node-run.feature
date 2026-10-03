# language: en
@trust-dsl:1 @operation:acceptance.node-run @version:1.0.0
Feature: Execute a required group of named Node tests against its current source and artifacts
  Runs the fixed acceptance helper; no agent-authored report is imported.

  Background: Operation interface
    Given Environment
      | name | type |
      | workspaceRoot | directory |
    And Input
      | input | type | cardinality |
      | contract | string | one |
      | layer | string | one |
      | expectedDigest | string | one |
    And Produced fields
      | field | type | cardinality | domain |
      | contractId | string | one | any |
      | layer | string | one | any |
      | sourceDigest | string | one | any |
      | afterDigest | string | one | any |
      | tested | number | one | any |
      | passed | number | one | any |
      | failed | number | one | any |
      | skipped | number | one | any |
      | crashed | number | one | any |
      | missing | number | one | any |
      | stale | number | one | any |
      | complete | number | one | any |
      | runId | string | one | any |
      | report | string | one | any |

  Scenario: Run
    When Shell "verification" runs "node" with cwd from Environment "workspaceRoot"
      | argument | source |
      | scripts/acceptance-verification.mjs | literal |
      | contract | Input "contract" |
      | layer | Input "layer" |
      | expectedDigest | Input "expectedDigest" |
      | execution | Execution "id" |
    Then Produce with JSONata
      """
      {
        "contractId": $split(steps.verification.stdout, "\n")[0],
        "layer": $split(steps.verification.stdout, "\n")[1],
        "sourceDigest": $split(steps.verification.stdout, "\n")[2],
        "afterDigest": $split(steps.verification.stdout, "\n")[3],
        "tested": $number($split(steps.verification.stdout, "\n")[4]),
        "passed": $number($split(steps.verification.stdout, "\n")[5]),
        "failed": $number($split(steps.verification.stdout, "\n")[6]),
        "skipped": $number($split(steps.verification.stdout, "\n")[7]),
        "crashed": $number($split(steps.verification.stdout, "\n")[8]),
        "missing": $number($split(steps.verification.stdout, "\n")[9]),
        "stale": $number($split(steps.verification.stdout, "\n")[10]),
        "complete": $number($split(steps.verification.stdout, "\n")[11]),
        "runId": $split(steps.verification.stdout, "\n")[12],
        "report": $split(steps.verification.stdout, "\n")[13]
      }
      """
