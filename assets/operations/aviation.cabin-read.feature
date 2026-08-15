# language: en
@trust-dsl:1 @operation:aviation.cabin-read @version:1.0.0
Feature: Read simulated cabin readiness for one flight

  Background: Operation interface
    Given Environment
      | name     | type |
      | cabinUrl | url  |
    And Input
      | input  | type      | cardinality |
      | flight | reference | one         |
    And Produced fields
      | field       | type      | cardinality | domain                  |
      | flight      | reference | one         | any                     |
      | cabinStatus | string    | one         | enum "ready", "not-ready" |

  Scenario: Run
    When HTTP "cabin" gets Environment "cabinUrl" appending Input "flight" as JSON
    Then Produce with JSONata
      """
      { "flight": input.flight, "cabinStatus": steps.cabin.body.cabinStatus }
      """
