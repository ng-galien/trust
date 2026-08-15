# language: en
@trust-dsl:1 @procedure:mono-project-change @version:1.0.0
Feature: Fix one Jira defect in one Maven project

  Background: Plan context
    Given one reference "jira issue"
    And one reference "project"
    And one reference "baseline revision" for "project"
    And one reference "fix revision" for "project"

  @scenario:issue
  Scenario: Read the Jira defect
    Then Check "issue" runs Operation "jira.issue-read" on "jira issue" as Input "issue" and must establish "the Jira issue is ready for correction"
      | field          | relation | expectation    | failure reason                  |
      | issueType      | equals   | value "defect" | "the Jira issue is not a defect" |
      | workflowStatus | equals   | value "todo"   | "the Jira issue is not ready"    |
    And the Scenario is satisfied when every Check is validated

  @scenario:baseline
  Scenario: Establish the project baseline
    Given scenario "issue" is validated
    Then Check "baseline" runs Operation "git.head-read" on "project" as Input "project" and materializes "baseline revision" from field "headRevision" and must establish "the project baseline is clean"
      | field       | relation | expectation   | failure reason                       |
      | workingTree | equals   | value "clean" | "the project has uncommitted changes" |
    And the Scenario is satisfied when every Check is validated

  @scenario:fix
  Scenario: Establish the committed fix
    Given scenario "baseline" is validated
    Then Check "fix" runs Operation "git.head-compare" on "project" as Input "project" using "baseline revision" as Input "baseRevision" and materializes "fix revision" from field "headRevision" and must establish "the fix is committed after the baseline"
      | field                | relation | expectation                 | failure reason                       |
      | comparedBaseRevision | equals   | context "baseline revision" | "the fix uses another baseline"       |
      | commitsAhead         | at least | number 1                    | "the fix is not committed"            |
      | workingTree          | equals   | value "clean"               | "the project has uncommitted changes"  |
    And the Scenario is satisfied when every Check is validated

  @scenario:verification
  Scenario: Verify the committed fix
    Given scenario "fix" is validated
    Then Check "Maven verification" runs Operation "maven.project-verify" on "project" as Input "project" using "fix revision" as Input "revision" and must establish "the committed fix passes Maven verification"
      | field              | relation | expectation           | failure reason                   |
      | verifiedRevision   | equals   | context "fix revision" | "Maven verified another revision" |
      | verificationStatus | equals   | value "successful"     | "Maven verification failed"       |
    And the Scenario is satisfied when every Check is validated
