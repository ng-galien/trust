# language: en
@trust-dsl:1 @operation:aviation.flight-read @version:1.0.0
Feature: Read simulated flight fuel planning data

  Background: Operation interface
    Given Environment
      | name      | type |
      | flightUrl | url  |
    And Input
      | input  | type      | cardinality |
      | flight | reference | one         |
    And Produced fields
      | field           | type      | cardinality | domain |
      | flight          | reference | one         | any    |
      | destination     | string    | one         | any    |
      | durationMinutes | number    | one         | any    |

  Scenario: Run
    When HTTP "flight" gets Environment "flightUrl" appending Input "flight" as JSON
    Then Produce with JSONata
      """
      {
        "flight": input.flight,
        "destination": steps.flight.body.destination,
        "durationMinutes": steps.flight.body.durationMinutes
      }
      """
