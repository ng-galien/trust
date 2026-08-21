# language: en
@trust-dsl:1 @procedure:mono-project-change @version:1.0.0
Feature: Fix one Jira defect in one Maven project

  Drives the correction of one Jira defect inside one Maven project, from a clean baseline
  to a verified revision: read the ticket, establish the baseline, verify the fixed revision
  and confirm the fix is committed.

  Background: Plan context
    Given one reference "jira issue"
    And one reference "project"
    And one reference "baseline revision" for "project"
    And one reference "fix revision" for "project"

  @scenario:issue
  Scenario: Read the Jira defect
    Then Check "issue" runs Operation "jira.issue-read" on "jira issue" as Input "issue" and must establish "the Jira issue is ready for correction"
      """js
      (
        fact.issueType === "defect" ||
        fail("the Jira issue is not a defect")
      ) &&
      (
        fact.workflowStatus === "todo" ||
        fail("the Jira issue is not ready")
      )
      """

  @scenario:baseline
  Scenario: Establish the project baseline
    Given scenario "issue" is validated
    Then Check "baseline" runs Operation "git.head-read" on "project" as Input "project" and materializes "baseline revision" from field "headRevision" and must establish "the project baseline is clean"
      """js
      fact.workingTree === "clean" ||
      fail("the project has uncommitted changes")
      """

  @scenario:fix
  Scenario: Establish the committed fix
    Given scenario "baseline" is validated
    Then Check "fix" runs Operation "git.head-compare" on "project" as Input "project" using "baseline revision" as Input "baseRevision" and materializes "fix revision" from field "headRevision" and must establish "the fix is committed after the baseline"
      """js
      (
        fact.comparedBaseRevision === context["baseline revision"] ||
        fail("the fix uses another baseline")
      ) &&
      (
        fact.commitsAhead >= 1 ||
        fail("the fix is not committed")
      ) &&
      (
        fact.workingTree === "clean" ||
        fail("the project has uncommitted changes")
      )
      """

  @scenario:verification
  Scenario: Verify the committed fix
    Given scenario "fix" is validated
    Then Check "Maven verification" runs Operation "maven.project-verify" on "project" as Input "project" using "fix revision" as Input "revision" and must establish "the committed fix passes Maven verification"
      """js
      (
        fact.verifiedRevision === context["fix revision"] ||
        fail("Maven verified another revision")
      ) &&
      (
        fact.verificationStatus === "successful" ||
        fail("Maven verification failed")
      )
      """
