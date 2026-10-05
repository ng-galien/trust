@trust-dsl:1 @operation:review.checklist-check @version:1.1.0
Feature: Check the shape and coverage of a declared independent review
  Reads the checklist supplied by the Plan and reports observations. TRUST retains the declarations and Facts.
  A reviewer's statements do not establish authenticated identity or replace executed acceptance tests.
  Same observation as 1.0.0, with the helper of the TRUST checkout reached as trust/scripts below the workspace where
  the projects live, so a mission on another project needs no TRUST script in that project.
  Background: Operation interface
    Given Environment
      | name | type |
      | workspaceRoot | directory |
    And Input
      | input | type | cardinality |
      | assignee | string | one |
      | reviewer | string | one |
      | rules | string | one |
      | contract | string | one |
      | checklist | string | one |
    And Produced fields
      | field | type | cardinality | domain |
      | reviewer | string | one | any |
      | assignee | string | one | any |
      | items | number | one | any |
      | passed | number | one | any |
      | failed | number | one | any |
      | missingRules | number | one | any |
      | missingCriteria | number | one | any |
      | withoutEvidence | number | one | any |
      | summary | string | one | any |
  Scenario: Run
    When Shell "review" runs "node" with cwd from Environment "workspaceRoot"
      | argument | source |
      | trust/scripts/review-checklist.mjs | literal |
      | assignee | Input "assignee" |
      | reviewer | Input "reviewer" |
      | rules | Input "rules" |
      | contract | Input "contract" |
      | checklist | Input "checklist" |
    Then Produce with JSONata
      """
      {
        "reviewer": $split(steps.review.stdout, "\n")[0],
        "assignee": $split(steps.review.stdout, "\n")[1],
        "items": $number($split(steps.review.stdout, "\n")[2]),
        "passed": $number($split(steps.review.stdout, "\n")[3]),
        "failed": $number($split(steps.review.stdout, "\n")[4]),
        "missingRules": $number($split(steps.review.stdout, "\n")[5]),
        "missingCriteria": $number($split(steps.review.stdout, "\n")[6]),
        "withoutEvidence": $number($split(steps.review.stdout, "\n")[7]),
        "summary": $split(steps.review.stdout, "\n")[8]
      }
      """
