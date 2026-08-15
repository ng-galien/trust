# language: en
@trust-dsl:1 @operation:git.head-compare @version:1.0.0
Feature: Compare Git HEAD with a baseline revision

  Background: Operation interface
    Given Environment
      | name        | type      |
      | projectRoot | directory |
    And Input
      | input        | type      | cardinality |
      | project      | reference | one         |
      | baseRevision | reference | one         |
    And Produced fields
      | field                | type      | cardinality | domain                |
      | headRevision         | reference | one         | any                   |
      | comparedBaseRevision | reference | one         | any                   |
      | commitsAhead         | number    | one         | any                   |
      | workingTree          | string    | one         | enum "clean", "dirty" |

  Scenario: Run
    When Shell "head" runs "git" with cwd from Environment "projectRoot"
      | argument  | source  |
      | rev-parse | literal |
      | --verify  | literal |
      | HEAD      | literal |
    And Shell "commits" runs "git" with cwd from Environment "projectRoot"
      | argument     | source               |
      | rev-list     | literal              |
      | --count      | literal              |
      | HEAD         | literal              |
      | --not        | literal              |
      | baseRevision | Input "baseRevision" |
    And Shell "status" runs "git" with cwd from Environment "projectRoot"
      | argument       | source  |
      | status         | literal |
      | --porcelain=v1 | literal |
    Then Produce with JSONata
      """
      {
        "headRevision": $trim(steps.head.stdout),
        "comparedBaseRevision": input.baseRevision,
        "commitsAhead": $number($trim(steps.commits.stdout)),
        "workingTree": $trim(steps.status.stdout) = "" ? "clean" : "dirty"
      }
      """
