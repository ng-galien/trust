# language: en
@trust-dsl:1 @operation:aviation.departure-release @version:1.0.0
Feature: Record one simulated flight departure release

  Background: Operation interface
    Given Environment
      | name                | type |
      | departureReleaseUrl | url  |
    And Input
      | input    | type      | cardinality |
      | aircraft | reference | one         |
      | flight   | reference | one         |
    And Produced fields
      | field         | type      | cardinality | domain                      |
      | flight        | reference | one         | any                         |
      | releaseStatus | string    | one         | enum "released", "rejected"  |

  Scenario: Run
    When HTTP "release" posts Input as JSON to Environment "departureReleaseUrl" and reads JSON
    Then Produce with JSONata
      """
      { "flight": input.flight, "releaseStatus": steps.release.body.releaseStatus }
      """
