# language: en
@trust-dsl:1 @operation:karate.change-reproduce @version:1.0.0
Feature: Reproduce a defect with a committed Karate change (red run)

  Observes the committed acceptance change and runs it in the red phase, in one Operation. In the
  acceptance project below the workspace: reads HEAD, counts the commits ahead of `baseRevision`,
  reads the working tree, then runs
  `mvn -B test -Dtrust.phase=red -Dtrust.ticket=<ticket> -Dtrust.run=<run>
  -Dtrust.execution.id=<executionId> <testArgument>`.
  Exit 1 with a Surefire summary (`Tests run:`) is the observation `defect-reproduced`; exit 0 is
  `not-reproduced`; any other exit (Maven cannot start, compilation error) interrupts the
  Operation. `testedRevision` is the observed HEAD, so a Procedure can materialize the acceptance
  test revision from the same run that reproduced the defect. `trust.ticket` and `trust.run`
  let the Karate features tag their traffic with the ticket and the Plan. TRUST supplies its
  execution id directly to the Operation context so the same traffic carries stable telemetry
  correlation for this run.

  Background: Operation interface
    Given Environment
      | name          | type      |
      | workspaceRoot | directory |
    And Input
      | input        | type      | cardinality |
      | project      | reference | one         |
      | baseRevision | reference | one         |
      | ticket       | reference | one         |
      | run          | reference | one         |
      | testArgument | string    | one         |
    And Produced fields
      | field                | type      | cardinality | domain                                     |
      | testedRevision       | reference | one         | any                                        |
      | comparedBaseRevision | reference | one         | any                                        |
      | commitsAhead         | number    | one         | any                                        |
      | workingTree          | string    | one         | enum "clean", "dirty"                      |
      | testStatus           | string    | one         | enum "defect-reproduced", "not-reproduced" |

  Scenario: Run
    When Shell "head" runs "git" with cwd from Environment "workspaceRoot" and Input "project"
      | argument  | source  |
      | rev-parse | literal |
      | --verify  | literal |
      | HEAD      | literal |
    And Shell "commits" runs "git" with cwd from Environment "workspaceRoot" and Input "project"
      | argument     | source               |
      | rev-list     | literal              |
      | --count      | literal              |
      | HEAD         | literal              |
      | --not        | literal              |
      | baseRevision | Input "baseRevision" |
    And Shell "status" runs "git" with cwd from Environment "workspaceRoot" and Input "project"
      | argument       | source  |
      | status         | literal |
      | --porcelain=v1 | literal |
    And Shell "test" runs "mvn" with cwd from Environment "workspaceRoot" and Input "project"
      | argument          | source                   |
      | -B                | literal                  |
      | test              | literal                  |
      | -Dtrust.phase=red | literal                  |
      | -Dtrust.ticket=   | literal + Input "ticket" |
      | -Dtrust.run=      | literal + Input "run"    |
      | -Dtrust.execution.id= | literal + Execution "id" |
      | testArgument      | Input "testArgument"     |
    And Shell "test" accepts exits
      | exit code | stdout contains | stderr contains |
      | 0         |                 |                 |
      | 1         | Tests run:      |                 |
    Then Produce with JSONata
      """
      {
        "testedRevision": $trim(steps.head.stdout),
        "comparedBaseRevision": input.baseRevision,
        "commitsAhead": $number($trim(steps.commits.stdout)),
        "workingTree": $trim(steps.status.stdout) = "" ? "clean" : "dirty",
        "testStatus": steps.test.exitCode = 1 ? "defect-reproduced" : "not-reproduced"
      }
      """
