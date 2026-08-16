# language: en
@trust-dsl:1 @operation:maven.project-verify @version:1.0.0
Feature: Verify one Maven project revision

  Runs `mvn -B verify` in the project checked out below the workspace and reports whether
  the build and its tests pass. Exit code 1 is an observation (`verificationStatus: failed`),
  not an error; any other exit interrupts the Operation.

  Background: Operation interface
    Given Environment
      | name          | type      |
      | workspaceRoot | directory |
    And Input
      | input    | type      | cardinality |
      | project  | reference | one         |
      | revision | reference | one         |
    And Produced fields
      | field              | type      | cardinality | domain                      |
      | verifiedProject    | reference | one         | any                         |
      | verifiedRevision   | reference | one         | any                         |
      | verificationStatus | string    | one         | enum "successful", "failed" |

  Scenario: Run
    When Shell "head" runs "git" with cwd from Environment "workspaceRoot" and Input "project"
      | argument  | source  |
      | rev-parse | literal |
      | --verify  | literal |
      | HEAD      | literal |
    And Shell "verify" runs "mvn" with cwd from Environment "workspaceRoot" and Input "project"
      | argument | source  |
      | -B       | literal |
      | verify   | literal |
    And Shell "verify" accepts exits
      | exit code | stdout contains | stderr contains |
      | 0         |                 |                 |
      | 1         |                 |                 |
    Then Produce with JSONata
      """
      {
        "verifiedProject": input.project,
        "verifiedRevision": $trim(steps.head.stdout),
        "verificationStatus": steps.verify.exitCode = 0 ? "successful" : "failed"
      }
      """
