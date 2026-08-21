# language: en
@trust-dsl:1 @operation:jira.issue-read @version:1.0.0
Feature: Read one Jira issue

  Background: Operation interface
    Given Environment
      | name         | type |
      | jiraIssueUrl | url  |
    And Input
      | input | type      | cardinality |
      | issue | reference | one         |
    And Produced fields
      | field          | type      | cardinality | domain                            |
      | issue          | reference | one         | any                               |
      | summary        | string    | one         | any                               |
      | issueType      | string    | one         | enum "defect", "story", "task"    |
      | workflowStatus | string    | one         | enum "todo", "in-progress", "done" |

  Scenario: Run
    When HTTP "issue" gets Environment "jiraIssueUrl" appending Input "issue" as JSON
    Then Produce with JSONata
      """
      {
        "issue": input.issue,
        "summary": steps.issue.body.fields.summary,
        "issueType": $lowercase(steps.issue.body.fields.issuetype.name),
        "workflowStatus": steps.issue.body.fields.status.name = "To Do" ? "todo" : steps.issue.body.fields.status.name = "In Progress" ? "in-progress" : "done"
      }
      """
