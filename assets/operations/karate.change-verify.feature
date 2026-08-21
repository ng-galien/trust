# language: en
@trust-dsl:1 @operation:karate.change-verify @version:1.0.0
Feature: Verify a deployed change with a committed Karate change (green run)

  Observes the committed acceptance change and runs it in the green phase, in one Operation. In the
  acceptance project below the workspace: reads HEAD, counts the commits ahead of `baseRevision`,
  reads the working tree, then runs
  `mvn -B test -Dtrust.phase=green -Dtrust.ticket=<ticket> -Dtrust.run=<run> <testArgument>`.
  Exit 0 is the observation `successful`; exit 1 with a Surefire summary (`Tests run:`) is
  `failed`; any other exit interrupts the Operation. `testedRevision` is the observed HEAD, so a
  Procedure can require that the green run used the revision the red run materialized. The
  `trust.phase` property lets the Karate features derive phase-specific run identities so the
  green run never reads side effects of the red run.

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
      | field                | type      | cardinality | domain                      |
      | testedRevision       | reference | one         | any                         |
      | comparedBaseRevision | reference | one         | any                         |
      | commitsAhead         | number    | one         | any                         |
      | workingTree          | string    | one         | enum "clean", "dirty"       |
      | testStatus           | string    | one         | enum "successful", "failed" |

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
      | argument            | source                   |
      | -B                  | literal                  |
      | test                | literal                  |
      | -Dtrust.phase=green | literal                  |
      | -Dtrust.ticket=     | literal + Input "ticket" |
      | -Dtrust.run=        | literal + Input "run"    |
      | testArgument        | Input "testArgument"     |
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
        "testStatus": steps.test.exitCode = 0 ? "successful" : "failed"
      }
      """
