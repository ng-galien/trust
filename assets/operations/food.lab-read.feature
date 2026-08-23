# language: en
@trust-dsl:1 @operation:food.lab-read @version:1.0.0
Feature: Read simulated laboratory results for one food batch

  Background: Operation interface
    Given Environment
      | name   | type |
      | labUrl | url  |
    And Input
      | input | type      | cardinality |
      | batch | reference | one         |
    And Produced fields
      | field     | type      | cardinality | domain                      |
      | batch     | reference | one         | any                         |
      | labStatus | string    | one         | enum "accepted", "rejected" |

  Scenario: Run
    When HTTP "lab" sends "GET" to Environment "labUrl" appending Input "batch" and reads JSON
    Then Produce with JSONata
      """
      { "batch": input.batch, "labStatus": steps.lab.body.labStatus }
      """
