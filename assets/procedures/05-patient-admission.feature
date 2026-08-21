# language: en
@trust-dsl:1 @procedure:patient-admission @version:1.0.0
Feature: Admit one patient with identity, coverage and consent confirmed

  Admits one patient once identity, coverage and consent are confirmed by the simulated
  healthcare services, then records the admission.

  Background: Plan context
    Given one reference "patient"
    And one reference "admission"
    And many reference "required document" declared by agent for "admission"
    And many instant "document record time" for each "required document"

  @scenario:identity
  Scenario: Confirm patient identity and allergy recording
    Then Check "patient record" runs Operation "healthcare.patient-read" on "patient" as Input "patient" and must establish "the patient record is ready for admission"
      """js
      (
        fact.identityStatus === "confirmed" ||
        fail("the patient identity is unconfirmed")
      ) &&
      (
        fact.allergyStatus === "recorded" ||
        fail("the allergy status is not recorded")
      )
      """

  @scenario:coverage
  Scenario: Confirm active coverage
    Given scenario "identity" is validated
    Then Check "coverage" runs Operation "healthcare.coverage-read" on "patient" as Input "patient" and must establish "the patient has active coverage"
      """js
      fact.coverageStatus === "active" ||
      fail("the patient has no active coverage")
      """

  @scenario:consent
  Scenario: Confirm admission consent
    Given scenario "coverage" is validated
    Then Check "consent" runs Operation "healthcare.consent-read" on "admission" as Input "admission" and must establish "the admission consent is signed"
      """js
      fact.consentStatus === "signed" ||
      fail("the admission consent is not signed")
      """

  @scenario:documents
  Scenario: Confirm every admission document
    Given scenario "identity" is validated
    Then Check "document" runs Operation "healthcare.document-read" on each "required document" as Input "document" and materializes "document record time" from field "recordedAt" and must establish "every admission document is confirmed"
      """js
      fact.documentStatus === "confirmed" ||
      fail("an admission document is not confirmed")
      """

  @scenario:admission
  Scenario: Record the patient admission
    Given scenario "consent" is validated
    And scenario "documents" is validated
    Then Check "admission" runs Operation "healthcare.admission-record" on "admission" as Input "admission" using "patient" as Input "patient" using all "required document" as Input "documents" using all "document record time" as Input "documentRecordedAt" and must establish "the patient admission is recorded"
      """js
      (
        fact.admissionStatus === "recorded" ||
        fail("the patient admission was rejected")
      ) &&
      (
        fact.admittedAt > checks.consent.signedAt ||
        fail("the admission predates its consent")
      )
      """
