# language: en
@trust-dsl:1 @operation:healthcare.patient-read @version:1.0.0
Feature: Read one simulated patient record

  Background: Operation interface
    Given Environment
      | name       | type |
      | patientUrl | url  |
    And Input
      | input   | type      | cardinality |
      | patient | reference | one         |
    And Produced fields
      | field          | type      | cardinality | domain                            |
      | patient        | reference | one         | any                               |
      | identityStatus | string    | one         | enum "confirmed", "unconfirmed"   |
      | allergyStatus  | string    | one         | enum "recorded", "not-recorded"    |

  Scenario: Run
    When HTTP "patient" sends "GET" to Environment "patientUrl" appending Input "patient" and reads JSON
    Then Produce with JSONata
      """
      {
        "patient": input.patient,
        "identityStatus": steps.patient.body.identityStatus,
        "allergyStatus": steps.patient.body.allergyStatus
      }
      """
