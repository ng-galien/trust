# language: en
@trust-dsl:1 @operation:coordination.review-record @version:1.0.0
Feature: Record an independent review checklist of one delegated mission
  The coordination database stores the reviewer's verdicts and counts them against the declared rules and the
  criteria of the acceptance contract. It refuses a review by the mission's assignee. The counts are observations;
  the verdicts remain the named reviewer's statements.

  Background: Operation interface
    Given Environment
      | name | type |
      | databaseUrl | string |
    And Credentials
      | name |
      | databasePassword |
    And Input
      | input | type | cardinality |
      | mission | string | one |
      | reviewer | string | one |
      | rules | string | one |
      | contract | string | one |
      | checklist | string | one |
    And Produced fields
      | field | type | cardinality | domain |
      | mission | string | one | any |
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
    When PostgreSQL "review" executes SQL on Environment "databaseUrl"
        authenticated by Credential "databasePassword" with Input as JSONB parameter $1
      """
      SELECT trust_coordination.review_record($1::jsonb) AS result
      """
    Then Produce with JSONata
      """
      {
        "mission": steps.review.result.mission,
        "reviewer": steps.review.result.reviewer,
        "assignee": steps.review.result.assignee,
        "items": steps.review.result.items,
        "passed": steps.review.result.passed,
        "failed": steps.review.result.failed,
        "missingRules": steps.review.result.missingRules,
        "missingCriteria": steps.review.result.missingCriteria,
        "withoutEvidence": steps.review.result.withoutEvidence,
        "summary": steps.review.result.summary
      }
      """
