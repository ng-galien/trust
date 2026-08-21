# language: en
@trust-dsl:1 @procedure:aircraft-departure @version:1.0.0
Feature: Release one aircraft and flight for departure

  Releases one aircraft and flight for departure once maintenance, fuel, weather and cabin
  readiness are confirmed by the simulated aviation services.

  Background: Plan context
    Given one reference "aircraft"
    And one reference "flight"

  @scenario:aircraft
  Scenario: Confirm aircraft release and fuel
    Then Check "aircraft" runs Operation "aviation.aircraft-read" on "aircraft" as Input "aircraft" and must establish "the aircraft is released with sufficient fuel"
      """js
      (
        fact.maintenanceStatus === "released" ||
        fail("the aircraft is not released")
      ) &&
      (
        fact.fuelStatus === "sufficient" ||
        fail("the aircraft has insufficient fuel")
      )
      """

  @scenario:weather
  Scenario: Accept the flight weather
    Given scenario "aircraft" is validated
    Then Check "weather" runs Operation "aviation.weather-read" on "flight" as Input "flight" and must establish "the flight weather is accepted"
      """js
      fact.weatherStatus === "accepted" ||
      fail("the flight weather is rejected")
      """

  @scenario:cabin
  Scenario: Confirm cabin readiness
    Given scenario "weather" is validated
    Then Check "cabin" runs Operation "aviation.cabin-read" on "flight" as Input "flight" and must establish "the cabin is ready for departure"
      """js
      fact.cabinStatus === "ready" ||
      fail("the cabin is not ready")
      """

  @scenario:release
  Scenario: Release the flight for departure
    Given scenario "cabin" is validated
    Then Check "departure release" runs Operation "aviation.departure-release" on "flight" as Input "flight" using "aircraft" as Input "aircraft" and must establish "the flight is released for departure"
      """js
      fact.releaseStatus === "released" ||
      fail("the flight departure was rejected")
      """
