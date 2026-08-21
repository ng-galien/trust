# language: en
@trust-dsl:1 @operation:git.change-merge @version:1.0.0
Feature: Merge a ticket branch into main

  Closes a change by merging its branch into `main` and reports the result, in one Operation. In
  the project below the workspace: runs `git switch main`, then
  `git merge --no-ff <branch> -m <ticket> -m "merged into main"`, so the merge commit is always
  created (no fast-forward) with the ticket key as subject and `merged into main` as body; then
  reads HEAD with `git rev-parse --verify HEAD` and the working tree with
  `git status --porcelain=v1`. Merge exit 0 is the observation `merged`; exit 1 is `failed`: a
  conflict, which leaves the merge in progress on `main` and `workingTree` `dirty` (the operator
  resolves or runs `git merge --abort` there; until then `git switch main` exits 128), or a branch
  that does not exist (`not something we can merge`, tree `clean`); any other exit (`main` that
  cannot be checked out) interrupts the Operation, the agent reads the Runner error and retries.
  `mergedRevision` is the HEAD after the merge, so a Procedure can record what `main` became. A
  branch with no commit ahead of `main` merges as `Already up to date` (exit 0, `merged`, no new
  commit). The ticket branch is kept, nothing is fetched or pushed: the local repository is the
  only remote for now.

  Background: Operation interface
    Given Environment
      | name          | type      |
      | workspaceRoot | directory |
    And Input
      | input   | type      | cardinality |
      | project | reference | one         |
      | branch  | reference | one         |
      | ticket  | reference | one         |
    And Produced fields
      | field          | type      | cardinality | domain                  |
      | mergedRevision | reference | one         | any                     |
      | mergeStatus    | string    | one         | enum "merged", "failed" |
      | workingTree    | string    | one         | enum "clean", "dirty"   |

  Scenario: Run
    When Shell "main" runs "git" with cwd from Environment "workspaceRoot" and Input "project"
      | argument | source  |
      | switch   | literal |
      | main     | literal |
    And Shell "merge" runs "git" with cwd from Environment "workspaceRoot" and Input "project"
      | argument         | source         |
      | merge            | literal        |
      | --no-ff          | literal        |
      | branch           | Input "branch" |
      | -m               | literal        |
      | ticket           | Input "ticket" |
      | -m               | literal        |
      | merged into main | literal        |
    And Shell "merge" accepts exits
      | exit code | stdout contains | stderr contains |
      | 0         |                 |                 |
      | 1         |                 |                 |
    And Shell "head" runs "git" with cwd from Environment "workspaceRoot" and Input "project"
      | argument  | source  |
      | rev-parse | literal |
      | --verify  | literal |
      | HEAD      | literal |
    And Shell "status" runs "git" with cwd from Environment "workspaceRoot" and Input "project"
      | argument       | source  |
      | status         | literal |
      | --porcelain=v1 | literal |
    Then Produce with JSONata
      """
      {
        "mergedRevision": $trim(steps.head.stdout),
        "mergeStatus": steps.merge.exitCode = 0 ? "merged" : "failed",
        "workingTree": $trim(steps.status.stdout) = "" ? "clean" : "dirty"
      }
      """
