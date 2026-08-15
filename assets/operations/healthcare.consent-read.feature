# language: en
@trust-dsl:1 @operation:healthcare.consent-read @version:1.0.0
Feature: Read simulated consent for one patient admission

  Background: Operation interface
    Given Environment
      | name       | type |
      | consentUrl | url  |
    And Input
      | input    | type      | cardinality |
      | admission | reference | one         |
    And Produced fields
      | field         | type      | cardinality | domain                      |
      | admission     | reference | one         | any                         |
      | consentStatus | string    | one         | enum "signed", "not-signed" |
      | signedAt      | instant   | one         | any                         |

  Scenario: Run
    When HTTP "consent" gets Environment "consentUrl" appending Input "admission" as JSON
    Then Produce with JSONata
      """
      {
        "admission": input.admission,
        "consentStatus": steps.consent.body.consentStatus,
        "signedAt": steps.consent.body.signedAt
      }
      """
