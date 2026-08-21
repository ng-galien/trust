# language: en
@trust-dsl:1 @operation:aviation.aircraft-fuel-provision @version:1.0.0
Feature: Ensure a simulated aircraft has its target fuel quantity

  Background: Operation interface
    Given Environment
      | name            | type |
      | aircraftFuelUrl | url  |
    And Input
      | input            | type      | cardinality |
      | aircraft         | reference | one         |
      | flight           | reference | one         |
      | targetFuelLiters | number    | one         |
    And Produced fields
      | field            | type      | cardinality | domain |
      | aircraft         | reference | one         | any    |
      | flight           | reference | one         | any    |
      | fuelBeforeLiters | number    | one         | any    |
      | fuelAfterLiters  | number    | one         | any    |
      | fuelAddedLiters  | number    | one         | any    |

  Scenario: Run
    When HTTP "fuel" posts Input as JSON to Environment "aircraftFuelUrl" and reads JSON
    Then Produce with JSONata
      """
      {
        "aircraft": input.aircraft,
        "flight": input.flight,
        "fuelBeforeLiters": steps.fuel.body.fuelBeforeLiters,
        "fuelAfterLiters": steps.fuel.body.fuelAfterLiters,
        "fuelAddedLiters": steps.fuel.body.fuelAddedLiters
      }
      """
