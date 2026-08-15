# language: en
@trust-dsl:1 @operation:aviation.aircraft-read @version:1.0.0
Feature: Read simulated aircraft release data

  Background: Operation interface
    Given Environment
      | name        | type |
      | aircraftUrl | url  |
    And Input
      | input    | type      | cardinality |
      | aircraft | reference | one         |
    And Produced fields
      | field             | type      | cardinality | domain                            |
      | aircraft          | reference | one         | any                               |
      | maintenanceStatus | string    | one         | enum "released", "not-released"   |
      | fuelStatus        | string    | one         | enum "sufficient", "insufficient"  |

  Scenario: Run
    When HTTP "aircraft" gets Environment "aircraftUrl" appending Input "aircraft" as JSON
    Then Produce with JSONata
      """
      {
        "aircraft": input.aircraft,
        "maintenanceStatus": steps.aircraft.body.maintenanceStatus,
        "fuelStatus": steps.aircraft.body.fuelStatus
      }
      """
