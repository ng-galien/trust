# language: en
@trust-dsl:1 @procedure:patient-admission @version:1.0.0
Feature: Admit one patient with identity, coverage and consent confirmed

  Background: Plan context
    Given one reference "patient"
    And one reference "admission"
    And many reference "required document" declared by agent for "admission"
    And many instant "document record time" for each "required document"

  @scenario:identity
  Scenario: Confirm patient identity and allergy recording
    Then Check "patient record" runs Operation "healthcare.patient-read" on "patient" as Input "patient" and must establish "the patient record is ready for admission"
      | field          | relation | expectation        | failure reason                     |
      | identityStatus | equals   | value "confirmed"   | "the patient identity is unconfirmed" |
      | allergyStatus  | equals   | value "recorded"    | "the allergy status is not recorded"   |
    And the Scenario is satisfied when every Check is validated

  @scenario:coverage
  Scenario: Confirm active coverage
    Given scenario "identity" is validated
    Then Check "coverage" runs Operation "healthcare.coverage-read" on "patient" as Input "patient" and must establish "the patient has active coverage"
      | field          | relation | expectation     | failure reason                 |
      | coverageStatus | equals   | value "active"  | "the patient has no active coverage" |
    And the Scenario is satisfied when every Check is validated

  @scenario:consent
  Scenario: Confirm admission consent
    Given scenario "coverage" is validated
    Then Check "consent" runs Operation "healthcare.consent-read" on "admission" as Input "admission" and must establish "the admission consent is signed"
      | field         | relation | expectation     | failure reason               |
      | consentStatus | equals   | value "signed"  | "the admission consent is not signed" |
    And the Scenario is satisfied when every Check is validated

  @scenario:documents
  Scenario: Confirm every admission document
    Given scenario "identity" is validated
    Then Check "document" runs Operation "healthcare.document-read" on each "required document" as Input "document" and materializes "document record time" from field "recordedAt" and must establish "every admission document is confirmed"
      | field          | relation | expectation       | failure reason                          |
      | documentStatus | equals   | value "confirmed" | "an admission document is not confirmed" |
    And the Scenario is satisfied when every Check is validated

  @scenario:admission
  Scenario: Record the patient admission
    Given scenario "consent" is validated
    And scenario "documents" is validated
    Then Check "admission" runs Operation "healthcare.admission-record" on "admission" as Input "admission" using "patient" as Input "patient" using all "required document" as Input "documents" using all "document record time" as Input "documentRecordedAt" and must establish "the patient admission is recorded"
      | field           | relation | expectation                           | failure reason                         |
      | admissionStatus | equals   | value "recorded"                      | "the patient admission was rejected"  |
      | admittedAt      | after    | field "signedAt" from Check "consent" | "the admission predates its consent"  |
    And the Scenario is satisfied when every Check is validated
