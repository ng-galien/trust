# language: en
@trust-dsl:1 @operation:food.batch-release @version:1.0.0
Feature: Record one simulated food batch release

  Background: Operation interface
    Given Environment
      | name       | type |
      | releaseUrl | url  |
    And Input
      | input | type      | cardinality |
      | batch | reference | one         |
    And Produced fields
      | field         | type      | cardinality | domain                      |
      | batch         | reference | one         | any                         |
      | releaseStatus | string    | one         | enum "released", "rejected"  |

  Scenario: Run
    When HTTP "release" sends "POST" to Environment "releaseUrl" with Input as JSON body and reads JSON
    Then Produce with JSONata
      """
      { "batch": input.batch, "releaseStatus": steps.release.body.releaseStatus }
      """
