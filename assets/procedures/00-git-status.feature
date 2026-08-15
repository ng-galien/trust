# language: en
@trust-dsl:1 @procedure:git-status @version:1.0.1
Feature: Observe a Git repository status

  Background: Procedure interface
    Given Skill capability "git.head-read" performs read and is replayable
    And Skill capability "git.head-read" accepts
      | input      | type      | cardinality |
      | repository | reference | one         |
    And Skill capability "git.head-read" reports
      | observation   | type      | cardinality | domain                |
      | head revision | reference | one         | any                   |
      | working tree  | string    | one         | enum "clean", "dirty" |
    And Skill capability "git.head-read" exposes outputs
      | output        | from observation | parents            |
      | head revision | head revision     | input "repository" |

    And one "repository"

  @scenario:repository-status
  Scenario: Observe a repository with local changes
    Then Check "repository status" uses Skill capability "git.head-read" on "repository" as input "repository" and must establish "the repository has local changes"
      | observation  | relation | expectation     | failure feedback                  |
      | working tree | equals   | literal "dirty" | "the repository has no local changes" |
    And the scenario is verified when all Skill actions are validated
