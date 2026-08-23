# language: en
@trust-dsl:1 @operation:food.batch-read @version:1.0.0
Feature: Read simulated food batch traceability

  Background: Operation interface
    Given Environment
      | name     | type |
      | batchUrl | url  |
    And Input
      | input | type      | cardinality |
      | batch | reference | one         |
    And Produced fields
      | field              | type      | cardinality | domain                        |
      | batch              | reference | one         | any                           |
      | traceabilityStatus | string    | one         | enum "complete", "incomplete" |

  Scenario: Run
    When HTTP "batch" sends "GET" to Environment "batchUrl" appending Input "batch" and reads JSON
    Then Produce with JSONata
      """
      { "batch": input.batch, "traceabilityStatus": steps.batch.body.traceabilityStatus }
      """
