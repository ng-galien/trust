# language: en
@trust-dsl:1 @procedure:aircraft-departure @version:1.0.0
Feature: Prepare and release one aircraft for departure

  Lets the agent inspect a flight and its aircraft, calculate a safe fuel target, provision only
  the missing fuel, then complete the departure checks.

  Background: Plan context
    Given one reference "aircraft"
    And one reference "flight"
    And one number "fuel target" declared by agent for "aircraft"

  @scenario:flight-plan
  Scenario: Read the flight fuel requirement
    Then Check "flight plan" runs Operation "aviation.flight-read" on "flight" as Input "flight" and must establish "the flight fuel requirement is available"
      """js
      (
        fact.destination.length > 0 ||
        fail("the flight destination is missing")
      ) &&
      (
        fact.durationMinutes > 0 ||
        fail("the flight duration must be positive")
      )
      """

  @scenario:aircraft
  Scenario: Read the aircraft fuel state
    Then Check "aircraft" runs Operation "aviation.aircraft-read" on "aircraft" as Input "aircraft" and must establish "the aircraft is released and its fuel state is available"
      """js
      (
        fact.maintenanceStatus === "released" ||
        fail("the aircraft is not released")
      ) &&
      (
        fact.currentFuelLiters >= 0 ||
        fail("the current fuel quantity is invalid")
      ) &&
      (
        fact.burnRateLitersPerHour > 0 ||
        fail("the aircraft fuel burn rate must be positive")
      )
      """

  @scenario:fuel
  Scenario: Provision the required departure fuel
    Given scenario "flight-plan" is validated
    And scenario "aircraft" is validated
    Then Check "fuel provision" runs Operation "aviation.aircraft-fuel-provision" on "aircraft" as Input "aircraft" using "flight" as Input "flight" using "fuel target" as Input "targetFuelLiters" and must establish "the aircraft has enough fuel for the flight and its reserve"
      """js
      (
        context["fuel target"] >= Math.ceil(
          ((checks["flight plan"].durationMinutes + 45) / 60) *
          checks.aircraft.burnRateLitersPerHour *
          1.05
        ) ||
        fail("the fuel target is below the required quantity")
      ) &&
      (
        fact.fuelAfterLiters >= Math.ceil(
          ((checks["flight plan"].durationMinutes + 45) / 60) *
          checks.aircraft.burnRateLitersPerHour *
          1.05
        ) ||
        fail("the aircraft still has insufficient fuel")
      )
      """

  @scenario:weather
  Scenario: Accept the flight weather
    Given scenario "fuel" is validated
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
