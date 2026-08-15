# language: en
@trust-dsl:1 @procedure:aircraft-departure @version:1.0.0
Feature: Release one aircraft and flight for departure

  Background: Plan context
    Given one reference "aircraft"
    And one reference "flight"

  @scenario:aircraft
  Scenario: Confirm aircraft release and fuel
    Then Check "aircraft" runs Operation "aviation.aircraft-read" on "aircraft" as Input "aircraft" and must establish "the aircraft is released with sufficient fuel"
      | field             | relation | expectation         | failure reason                         |
      | maintenanceStatus | equals   | value "released"     | "the aircraft is not released"          |
      | fuelStatus        | equals   | value "sufficient"   | "the aircraft has insufficient fuel"    |
    And the Scenario is satisfied when every Check is validated

  @scenario:weather
  Scenario: Accept the flight weather
    Given scenario "aircraft" is validated
    Then Check "weather" runs Operation "aviation.weather-read" on "flight" as Input "flight" and must establish "the flight weather is accepted"
      | field         | relation | expectation       | failure reason                |
      | weatherStatus | equals   | value "accepted"   | "the flight weather is rejected" |
    And the Scenario is satisfied when every Check is validated

  @scenario:cabin
  Scenario: Confirm cabin readiness
    Given scenario "weather" is validated
    Then Check "cabin" runs Operation "aviation.cabin-read" on "flight" as Input "flight" and must establish "the cabin is ready for departure"
      | field       | relation | expectation   | failure reason             |
      | cabinStatus | equals   | value "ready" | "the cabin is not ready"     |
    And the Scenario is satisfied when every Check is validated

  @scenario:release
  Scenario: Release the flight for departure
    Given scenario "cabin" is validated
    Then Check "departure release" runs Operation "aviation.departure-release" on "flight" as Input "flight" using "aircraft" as Input "aircraft" and must establish "the flight is released for departure"
      | field         | relation | expectation      | failure reason                  |
      | releaseStatus | equals   | value "released"  | "the flight departure was rejected" |
    And the Scenario is satisfied when every Check is validated
