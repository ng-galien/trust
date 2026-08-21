# language: en
@trust-dsl:1 @operation:maven.change-verify @version:1.0.0
Feature: Verify a committed change with Maven

  Observes the committed change and verifies it, in one Operation. In the project below the
  workspace: reads HEAD, counts the commits ahead of `baseRevision`, reads the working tree, then
  runs `mvn -B verify -Dtrust.ticket=<ticket>`. Exit 0 is the observation `successful`, exit 1 is
  `failed`; any other exit interrupts the Operation. `verifiedRevision` is the observed HEAD, so a
  Procedure can materialize the fix revision from the same run that verified it, and later Checks
  can require that revision to be the one built and deployed.

  Background: Operation interface
    Given Environment
      | name          | type      |
      | workspaceRoot | directory |
    And Input
      | input        | type      | cardinality |
      | project      | reference | one         |
      | baseRevision | reference | one         |
      | ticket       | reference | one         |
    And Produced fields
      | field                | type      | cardinality | domain                      |
      | verifiedRevision     | reference | one         | any                         |
      | comparedBaseRevision | reference | one         | any                         |
      | commitsAhead         | number    | one         | any                         |
      | workingTree          | string    | one         | enum "clean", "dirty"       |
      | verificationStatus   | string    | one         | enum "successful", "failed" |

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
    And Shell "verify" runs "mvn" with cwd from Environment "workspaceRoot" and Input "project"
      | argument        | source                   |
      | -B              | literal                  |
      | verify          | literal                  |
      | -Dtrust.ticket= | literal + Input "ticket" |
    And Shell "verify" accepts exits
      | exit code | stdout contains | stderr contains |
      | 0         |                 |                 |
      | 1         |                 |                 |
    Then Produce with JSONata
      """
      {
        "verifiedRevision": $trim(steps.head.stdout),
        "comparedBaseRevision": input.baseRevision,
        "commitsAhead": $number($trim(steps.commits.stdout)),
        "workingTree": $trim(steps.status.stdout) = "" ? "clean" : "dirty",
        "verificationStatus": steps.verify.exitCode = 0 ? "successful" : "failed"
      }
      """
