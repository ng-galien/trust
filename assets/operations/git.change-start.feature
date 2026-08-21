# language: en
@trust-dsl:1 @operation:git.change-start @version:1.0.0
Feature: Start a change on a ticket branch cut from the clean main baseline

  Puts the project on the ticket branch and reports the baseline it was cut from, in one
  Operation. In the project below the workspace: runs `git switch main` first, so a branch left
  checked out by a previous ticket never becomes the baseline; then reads the working tree with
  `git status --porcelain=v1` and HEAD with `git rev-parse --verify HEAD` while still on `main`;
  then runs `git switch -C <branch>`, which creates the branch at that HEAD or resets an existing
  branch of the same name to it, so a re-run of the same ticket restarts cleanly from `main`; and
  finally reads the current branch with `git rev-parse --abbrev-ref HEAD`. Every step must exit 0:
  a `main` that cannot be checked out (local changes in conflict with it) or a `switch -C` that
  fails interrupts the Operation, the agent reads the Runner error and retries. `baseRevision` is
  the `main` HEAD read before the switch, so a Procedure can materialize the baseline revision from
  the same run that opened the branch, and later Checks can count the commits ahead of it.
  `workingTree` reports local changes carried over onto the branch; `branch` is the branch really
  checked out at the end, so a Procedure can require it to be the ticket branch. Nothing is
  fetched, pushed or committed.

  Background: Operation interface
    Given Environment
      | name          | type      |
      | workspaceRoot | directory |
    And Input
      | input   | type      | cardinality |
      | project | reference | one         |
      | branch  | reference | one         |
    And Produced fields
      | field        | type      | cardinality | domain                |
      | baseRevision | reference | one         | any                   |
      | workingTree  | string    | one         | enum "clean", "dirty" |
      | branch       | reference | one         | any                   |

  Scenario: Run
    When Shell "main" runs "git" with cwd from Environment "workspaceRoot" and Input "project"
      | argument | source  |
      | switch   | literal |
      | main     | literal |
    And Shell "status" runs "git" with cwd from Environment "workspaceRoot" and Input "project"
      | argument       | source  |
      | status         | literal |
      | --porcelain=v1 | literal |
    And Shell "head" runs "git" with cwd from Environment "workspaceRoot" and Input "project"
      | argument  | source  |
      | rev-parse | literal |
      | --verify  | literal |
      | HEAD      | literal |
    And Shell "switch" runs "git" with cwd from Environment "workspaceRoot" and Input "project"
      | argument | source         |
      | switch   | literal        |
      | -C       | literal        |
      | branch   | Input "branch" |
    And Shell "branch" runs "git" with cwd from Environment "workspaceRoot" and Input "project"
      | argument     | source  |
      | rev-parse    | literal |
      | --abbrev-ref | literal |
      | HEAD         | literal |
    Then Produce with JSONata
      """
      {
        "baseRevision": $trim(steps.head.stdout),
        "workingTree": $trim(steps.status.stdout) = "" ? "clean" : "dirty",
        "branch": $trim(steps.branch.stdout)
      }
      """
