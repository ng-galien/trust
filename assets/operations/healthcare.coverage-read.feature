# language: en
@trust-dsl:1 @operation:healthcare.coverage-read @version:1.0.0
Feature: Read simulated coverage for one patient

  Background: Operation interface
    Given Environment
      | name        | type |
      | coverageUrl | url  |
    And Input
      | input   | type      | cardinality |
      | patient | reference | one         |
    And Produced fields
      | field          | type      | cardinality | domain                        |
      | patient        | reference | one         | any                           |
      | coverageStatus | string    | one         | enum "active", "inactive"     |

  Scenario: Run
    When HTTP "coverage" sends "GET" to Environment "coverageUrl" appending Input "patient" and reads JSON
    Then Produce with JSONata
      """
      { "patient": input.patient, "coverageStatus": steps.coverage.body.coverageStatus }
      """
