# language: en
@trust-dsl:1 @operation:karate.defect-reproduce @version:1.0.0
Feature: Run one Karate test that must reproduce a defect

  Runs `mvn -B test -Dtrust.phase=red -Dtrust.execution.id=<executionId> <testArgument>` at the
  project HEAD and reports whether the selected Karate tests fail (exit 1 with a Surefire summary =
  defect reproduced). `testedRevision` is the observed HEAD, so a Procedure can compare it with the
  committed test revision. The `trust.phase` property lets Karate features derive phase-specific
  run identities so that the red run and the green run never share side effects. TRUST supplies its
  execution id directly to the Operation context so the test traffic can carry it as telemetry
  correlation.

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
      | field          | type      | cardinality | domain                                    |
      | testedProject  | reference | one         | any                                       |
      | testedRevision | reference | one         | any                                       |
      | testStatus     | string    | one         | enum "defect-reproduced", "not-reproduced" |

  Scenario: Run
    When Shell "head" runs "git" with cwd from Environment "workspaceRoot" and Input "project"
      | argument  | source  |
      | rev-parse | literal |
      | --verify  | literal |
      | HEAD      | literal |
    And Shell "test" runs "mvn" with cwd from Environment "workspaceRoot" and Input "project"
      | argument           | source               |
      | -B                 | literal              |
      | test               | literal              |
      | -Dtrust.phase=red  | literal              |
      | -Dtrust.execution.id= | literal + Execution "id" |
      | testArgument       | Input "testArgument" |
    And Shell "test" accepts exits
      | exit code | stdout contains | stderr contains |
      | 0         |                 |                 |
      | 1         | Tests run:      |                 |
    Then Produce with JSONata
      """
      {
        "testedProject": input.project,
        "testedRevision": $trim(steps.head.stdout),
        "testStatus": steps.test.exitCode = 1 ? "defect-reproduced" : "not-reproduced"
      }
      """
