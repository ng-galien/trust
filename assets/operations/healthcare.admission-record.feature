# language: en
@trust-dsl:1 @operation:healthcare.admission-record @version:1.0.0
Feature: Record one simulated patient admission

  Background: Operation interface
    Given Environment
      | name         | type |
      | admissionUrl | url  |
    And Input
      | input              | type      | cardinality |
      | patient            | reference | one         |
      | admission          | reference | one         |
      | documents          | reference | many        |
      | documentRecordedAt | instant   | many        |
    And Produced fields
      | field           | type      | cardinality | domain                      |
      | admission       | reference | one         | any                         |
      | admissionStatus | string    | one         | enum "recorded", "rejected" |
      | admittedAt      | instant   | one         | any                         |

  Scenario: Run
    When HTTP "admission" sends "POST" to Environment "admissionUrl" with Input as JSON body and reads JSON
    Then Produce with JSONata
      """
      {
        "admission": input.admission,
        "admissionStatus": steps.admission.body.admissionStatus,
        "admittedAt": steps.admission.body.admittedAt
      }
      """
