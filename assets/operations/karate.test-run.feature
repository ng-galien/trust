# language: en
@trust-dsl:1 @operation:karate.test-run @version:1.0.0
Feature: Run one Karate test selection

  Runs `mvn -B test -Dtrust.phase=green -Dtrust.execution.id=<executionId> <testArgument>` at the
  project HEAD and reports whether the selected Karate tests pass. `testedRevision` is the observed
  HEAD, so a Procedure can compare it with the committed test revision. The `trust.phase` property
  lets Karate features derive phase-specific run identities so that the green run never reads side
  effects of the red run. TRUST supplies its execution id directly to the Operation context so the
  test traffic can carry it as telemetry correlation.

  Background: Operation interface
    Given Environment
      | name          | type      |
      | workspaceRoot | directory |
    And Input
      | input        | type      | cardinality |
      | project      | reference | one         |
      | revision     | reference | one         |
      | testArgument | string    | one         |
    And Produced fields
      | field          | type      | cardinality | domain                      |
      | testedProject  | reference | one         | any                         |
      | testedRevision | reference | one         | any                         |
      | testStatus     | string    | one         | enum "successful", "failed" |

  Scenario: Run
    When Shell "head" runs "git" with cwd from Environment "workspaceRoot" and Input "project"
      | argument  | source  |
      | rev-parse | literal |
      | --verify  | literal |
      | HEAD      | literal |
    And Shell "test" runs "mvn" with cwd from Environment "workspaceRoot" and Input "project"
      | argument             | source               |
      | -B                   | literal              |
      | test                 | literal              |
      | -Dtrust.phase=green  | literal              |
      | -Dtrust.execution.id= | literal + Execution "id" |
      | testArgument         | Input "testArgument" |
    And Shell "test" accepts exits
      | exit code | stdout contains | stderr contains |
      | 0         |                 |                 |
      | 1         |                 |                 |
    Then Produce with JSONata
      """
      {
        "testedProject": input.project,
        "testedRevision": $trim(steps.head.stdout),
        "testStatus": steps.test.exitCode = 0 ? "successful" : "failed"
      }
      """
