# language: en
@trust-dsl:1 @operation:git.head-read @version:1.0.0
Feature: Read Git HEAD and working tree

  Background: Operation interface
    Given Environment
      | name        | type |
      | projectRoot | directory |
    And Input
      | input   | type      | cardinality |
      | project | reference | one         |
    And Produced fields
      | field        | type      | cardinality | domain                |
      | headRevision | reference | one         | any                   |
      | workingTree  | string    | one         | enum "clean", "dirty" |

  Scenario: Run
    When Shell "head" runs "git" with cwd from Environment "projectRoot"
      | argument  | source  |
      | rev-parse | literal |
      | --verify  | literal |
      | HEAD      | literal |
    And Shell "status" runs "git" with cwd from Environment "projectRoot"
      | argument                 | source  |
      | status                   | literal |
      | --porcelain=v1           | literal |
      | --untracked-files=normal | literal |
    Then Produce with JSONata
      """
      {
        "headRevision": $trim(steps.head.stdout),
        "workingTree": $trim(steps.status.stdout) = "" ? "clean" : "dirty"
      }
      """
