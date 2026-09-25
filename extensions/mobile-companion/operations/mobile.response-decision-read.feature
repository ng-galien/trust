# language: en
@trust-dsl:1 @operation:mobile.response-decision-read @version:1.0.0
Feature: Read an approved mobile decision response

  Background: Operation interface
    Given Environment
      | name              | type |
      | mobileResponseUrl | url  |
    And Input
      | input | type      | cardinality |
      | item  | reference | one         |
    And Produced fields
      | field            | type      | cardinality | domain |
      | item             | reference | one         | any    |
      | decision         | string    | one         | any    |
      | formRevision     | number    | one         | any    |
      | responseRevision | number    | one         | any    |

  Scenario: Run
    When HTTP "response" sends "GET" to Environment "mobileResponseUrl" appending Input "item" and reads JSON
    Then Produce with JSONata
      """
      {
        "item": steps.response.body.item,
        "decision": steps.response.body.answers.decision,
        "formRevision": steps.response.body.formRevision,
        "responseRevision": steps.response.body.responseRevision
      }
      """
