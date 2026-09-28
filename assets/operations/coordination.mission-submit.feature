# language: en
@trust-dsl:1 @operation:coordination.mission-submit @version:1.1.0
Feature: Submit one delegated mission
  Persisted agent statements are observations of the coordination database, not proof of task correctness.

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
      | actor | string | one |
      | outcome | string | one |
      | response | string | one |
    And Produced fields
      | field | type | cardinality | domain |
      | mission | string | one | any |
      | plan | string | one | any |
      | assignee | string | one | any |
      | owner | string | one | any |
      | state | string | one | any |
      | instructions | string | one | any |
      | project | string | one | any |
      | expected | string | one | any |
      | authorized | string | one | any |
      | forbidden | string | one | any |
      | response | string | one | any |

  Scenario: Run
    When PostgreSQL "mission" executes SQL on Environment "databaseUrl"
        authenticated by Credential "databasePassword" with Input as JSONB parameter $1
      """
      SELECT trust_coordination.mission_submit($1::jsonb) AS result
      """
    Then Produce with JSONata
      """
      {
        "mission": steps.mission.result.mission,
        "plan": steps.mission.result.plan,
        "assignee": steps.mission.result.assignee,
        "owner": steps.mission.result.owner,
        "state": steps.mission.result.state,
        "instructions": steps.mission.result.instructions,
        "project": steps.mission.result.project,
        "expected": steps.mission.result.expected,
        "authorized": steps.mission.result.authorized,
        "forbidden": steps.mission.result.forbidden,
        "response": steps.mission.result.response
      }
      """
