# language: en
@trust-dsl:1 @operation:acceptance.node-repeat @version:1.0.0
Feature: Repeat a required group of named Node tests on unchanged code to observe its stability
  Runs the fixed timed acceptance helper; no agent-authored report is imported. The contract's test files run
  "runs" times in a row (2 to 10), "concurrency" files at once (1 to 8). Each run is judged like
  acceptance.node-run and gets an equal share of 540 s, at most 120 s. The repetition stops when the code changed.

  Background: Operation interface
    Given Environment
      | name | type |
      | workspaceRoot | directory |
    And Input
      | input | type | cardinality |
      | contract | string | one |
      | layer | string | one |
      | expectedDigest | string | one |
      | runs | string | one |
      | concurrency | string | one |
    And Produced fields
      | field | type | cardinality | domain |
      | contractId | string | one | any |
      | layer | string | one | any |
      | sourceDigest | string | one | any |
      | afterDigest | string | one | any |
      | requestedRuns | number | one | any |
      | concurrency | number | one | any |
      | runs | number | one | any |
      | passedRuns | number | one | any |
      | failedRuns | number | one | any |
      | unstableTests | number | one | any |
      | minDurationMs | number | one | any |
      | maxDurationMs | number | one | any |
      | stale | number | one | any |
      | stable | number | one | any |
      | runId | string | one | any |
      | report | string | one | any |

  Scenario: Run
    When Shell "repetition" runs "node" with cwd from Environment "workspaceRoot"
      | argument | source |
      | scripts/acceptance-timed-verification.mjs | literal |
      | repeat | literal |
      | contract | Input "contract" |
      | layer | Input "layer" |
      | expectedDigest | Input "expectedDigest" |
      | runs | Input "runs" |
      | concurrency | Input "concurrency" |
      | execution | Execution "id" |
    Then Produce with JSONata
      """
      {
        "contractId": $split(steps.repetition.stdout, "\n")[0],
        "layer": $split(steps.repetition.stdout, "\n")[1],
        "sourceDigest": $split(steps.repetition.stdout, "\n")[2],
        "afterDigest": $split(steps.repetition.stdout, "\n")[3],
        "requestedRuns": $number($split(steps.repetition.stdout, "\n")[4]),
        "concurrency": $number($split(steps.repetition.stdout, "\n")[5]),
        "runs": $number($split(steps.repetition.stdout, "\n")[6]),
        "passedRuns": $number($split(steps.repetition.stdout, "\n")[7]),
        "failedRuns": $number($split(steps.repetition.stdout, "\n")[8]),
        "unstableTests": $number($split(steps.repetition.stdout, "\n")[9]),
        "minDurationMs": $number($split(steps.repetition.stdout, "\n")[10]),
        "maxDurationMs": $number($split(steps.repetition.stdout, "\n")[11]),
        "stale": $number($split(steps.repetition.stdout, "\n")[12]),
        "stable": $number($split(steps.repetition.stdout, "\n")[13]),
        "runId": $split(steps.repetition.stdout, "\n")[14],
        "report": $split(steps.repetition.stdout, "\n")[15]
      }
      """
