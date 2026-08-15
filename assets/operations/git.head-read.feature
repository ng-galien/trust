# language: en
@trust-dsl:1 @operation:git.head-read @version:1.0.0
Feature: Read Git HEAD and working tree

  Background: Operation interface
    Given Environment
      | name        | type |
      | projectRoot | directory |
    And Produced fields
      | field        | type      | cardinality | domain                |
      | headRevision | reference | one         | any                   |
      | workingTree  | string    | one         | enum "clean", "dirty" |

  Scenario: Run
    When Shell "head" runs "git" with cwd from Environment "projectRoot"
      | argument  |
      | rev-parse |
      | --verify  |
      | HEAD      |
    And Shell "status" runs "git" with cwd from Environment "projectRoot"
      | argument                 |
      | status                   |
      | --porcelain=v1           |
      | --untracked-files=normal |
    Then Produce with JSONata
      """
      {
        "headRevision": $trim(steps.head.stdout),
        "workingTree": $trim(steps.status.stdout) = "" ? "clean" : "dirty"
      }
      """
