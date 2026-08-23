# language: en
@trust-dsl:1 @operation:aviation.weather-read @version:1.0.0
Feature: Read simulated weather for one flight

  Background: Operation interface
    Given Environment
      | name       | type |
      | weatherUrl | url  |
    And Input
      | input  | type      | cardinality |
      | flight | reference | one         |
    And Produced fields
      | field         | type      | cardinality | domain                      |
      | flight        | reference | one         | any                         |
      | weatherStatus | string    | one         | enum "accepted", "rejected" |

  Scenario: Run
    When HTTP "weather" sends "GET" to Environment "weatherUrl" appending Input "flight" and reads JSON
    Then Produce with JSONata
      """
      { "flight": input.flight, "weatherStatus": steps.weather.body.weatherStatus }
      """
