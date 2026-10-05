# language: en
@trust-dsl:1 @operation:acceptance.vitest-run @version:1.0.0
Feature: Execute the named Vitest tests of a mission contract at the root of the repository of the Plan environment
  Runs the fixed Vitest acceptance helper of the TRUST checkout (trust/scripts below the workspace where the projects
  live) on the project named by Input project, at that project's root and with its own Vitest; the tested project holds
  only its code and its tests. No agent-authored report is imported. Same counts, digests and duration as
  acceptance.node-run@1.1.0; a named test absent from the run counts as missing, a code change as stale.

  Background: Operation interface
    Given Environment
      | name | type |
      | workspaceRoot | directory |
    And Input
      | input | type | cardinality |
      | project | string | one |
      | contract | string | one |
      | expectedDigest | string | one |
    And Produced fields
      | field | type | cardinality | domain |
      | contractId | string | one | any |
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
      | durationMs | number | one | any |
      | reason | string | one | any |
      | report | string | one | any |

  Scenario: Run
    When Shell "verification" runs "node" with cwd from Environment "workspaceRoot"
      | argument | source |
      | trust/scripts/acceptance-vitest-verification.mjs | literal |
      | run | literal |
      | project | Input "project" |
      | contract | Input "contract" |
      | expectedDigest | Input "expectedDigest" |
      | execution | Execution "id" |
    Then Produce with JSONata
      """
      {
        "contractId": $split(steps.verification.stdout, "\n")[0],
        "sourceDigest": $split(steps.verification.stdout, "\n")[1],
        "afterDigest": $split(steps.verification.stdout, "\n")[2],
        "tested": $number($split(steps.verification.stdout, "\n")[3]),
        "passed": $number($split(steps.verification.stdout, "\n")[4]),
        "failed": $number($split(steps.verification.stdout, "\n")[5]),
        "skipped": $number($split(steps.verification.stdout, "\n")[6]),
        "crashed": $number($split(steps.verification.stdout, "\n")[7]),
        "missing": $number($split(steps.verification.stdout, "\n")[8]),
        "stale": $number($split(steps.verification.stdout, "\n")[9]),
        "complete": $number($split(steps.verification.stdout, "\n")[10]),
        "runId": $split(steps.verification.stdout, "\n")[11],
        "durationMs": $number($split(steps.verification.stdout, "\n")[12]),
        "reason": $split(steps.verification.stdout, "\n")[13],
        "report": $split(steps.verification.stdout, "\n")[14]
      }
      """
