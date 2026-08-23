# language: en
@trust-dsl:1 @operation:jira.issue-transition @version:1.0.0
Feature: Transition one Jira issue between two exact workflow statuses

  Reads the issue before mutation, resolves the transition offered by Jira for the requested target,
  applies it, and reads the issue again. A mismatched status stops the Operation before POST. When a
  replay already observes the target status, it sends an intentionally unavailable transition and
  accepts Jira's refusal before confirming the target again.

  Background: Operation interface
    Given Environment
      | name         | type |
      | jiraIssueUrl | url  |
    And Input
      | input              | type      | cardinality |
      | issue              | reference | one         |
      | fromWorkflowStatus | string    | one         |
      | toWorkflowStatus   | string    | one         |
    And Produced fields
      | field              | type      | cardinality | domain                                                    |
      | issue              | reference | one         | any                                                       |
      | fromWorkflowStatus | string    | one         | enum "todo", "in-progress", "in-review", "done", "other" |
      | toWorkflowStatus   | string    | one         | enum "todo", "in-progress", "in-review", "done", "other" |

  Scenario: Run
    When HTTP "before" sends "GET" to Environment "jiraIssueUrl" appending Input "issue" and reads JSON
    And HTTP "transitions" sends "GET" to Environment "jiraIssueUrl" appending Input "issue" and literal "transitions" and reads JSON
    And HTTP "transition" sends "POST" to Environment "jiraIssueUrl" appending Input "issue" and literal "transitions" with JSONata body and reads no body
      """
      (
        $assert(
          ((
            steps.before.body.fields.status.name = "To Do" ? "todo" :
            steps.before.body.fields.status.name = "In Progress" ? "in-progress" :
            steps.before.body.fields.status.name = "In Review" ? "in-review" :
            steps.before.body.fields.status.name = "Done" ? "done" : "other"
          ) = input.fromWorkflowStatus) or ((
            steps.before.body.fields.status.name = "To Do" ? "todo" :
            steps.before.body.fields.status.name = "In Progress" ? "in-progress" :
            steps.before.body.fields.status.name = "In Review" ? "in-review" :
            steps.before.body.fields.status.name = "Done" ? "done" : "other"
          ) = input.toWorkflowStatus),
          "Jira issue has neither the expected source nor target workflow status"
        );
        {
          "transition": {
            "id": (
              steps.before.body.fields.status.name = "To Do" ? "todo" :
              steps.before.body.fields.status.name = "In Progress" ? "in-progress" :
              steps.before.body.fields.status.name = "In Review" ? "in-review" :
              steps.before.body.fields.status.name = "Done" ? "done" : "other"
            ) = input.toWorkflowStatus ? "__trust_already_applied__" : $single(
                steps.transitions.body.transitions[
                  to.name = (
                    $$.input.toWorkflowStatus = "todo" ? "To Do" :
                    $$.input.toWorkflowStatus = "in-progress" ? "In Progress" :
                    $$.input.toWorkflowStatus = "in-review" ? "In Review" :
                    $$.input.toWorkflowStatus = "done" ? "Done" : ""
                  )
                ]
              ).id
          }
        }
      )
      """
    And HTTP "transition" accepts statuses
      | status |
      | 200    |
      | 204    |
      | 400    |
    And HTTP "after" sends "GET" to Environment "jiraIssueUrl" appending Input "issue" and reads JSON
    Then Produce with JSONata
      """
      {
        "issue": input.issue,
        "fromWorkflowStatus": input.fromWorkflowStatus,
        "toWorkflowStatus": steps.after.body.fields.status.name = "To Do" ? "todo" : steps.after.body.fields.status.name = "In Progress" ? "in-progress" : steps.after.body.fields.status.name = "In Review" ? "in-review" : steps.after.body.fields.status.name = "Done" ? "done" : "other"
      }
      """
