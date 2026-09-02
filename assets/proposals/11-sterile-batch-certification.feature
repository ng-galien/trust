# language: en
@trust-dsl:1 @procedure:sterile-batch-certification @version:0.1.0
Feature: Certify and release one sterile batch under Qualified Person responsibility

  GMP Annex 16 style batch certification. The agent is the batch-record review agent: it reads
  the executed batch record (hundreds of pages of manufacturing steps, signatures, in-process
  controls), detects anomalies, opens and drives the deviations to closure with quality, follows
  the QC tests, and assembles the certification dossier for the Qualified Person. That work is
  investigation and coordination across the MES, the LIMS, the QMS and the cold-chain monitoring
  system — an agent working for days, not a script. What the agent DECLARES is the outcome of its
  review: the deviations it identified and treated, and the Qualified Person it routes the
  dossier to. What it can never do is produce its own evidence:

  - the required QC tests come from the product specification read in the LIMS, not from the
    agent — a test the agent would rather not mention is still required;
  - the open-deviation count comes from the QMS, so a deviation the agent did not declare
    blocks the release anyway;
  - the cold chain is read from the monitoring system;
  - the certification is signed by an authorized Qualified Person while the authorization is
    valid, after every test result, and the release follows the certification.

  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all   | Observe and perform only the declared sterile batch certification activities. | Alter manufacturing, laboratory, authorization, or release evidence to manufacture conformity. |
    Given one reference "batch"
    And one reference "manufacturing site" fixed as "site-lyon-1"
    And many reference "required test" for "batch"
    And many instant "test time" for each "required test"
    And many reference "deviation" declared by agent for "batch"
    And one reference "qualified person" declared by agent
    And one instant "authorization expiry"

  @scenario:batch-record
  Scenario: Confirm the executed batch record is complete and the tests are known
    Then Check "record" runs Operation "pharma.batch-read"
        on "batch" as Input "batch"
        and materializes "required test" from field "requiredTests"
        and must establish "the executed batch record is complete and in quarantine"
      """js
      (
        fact.batchStatus === "quarantine" ||
        fail("the batch is not in quarantine")
      ) &&
      (
        fact.recordStatus === "complete" ||
        fail("the executed batch record is incomplete")
      )
      """

  @scenario:qc-results
  Scenario: Confirm every required QC test passed
    Given scenario "batch-record" is validated
    Then Check "test result" runs Operation "pharma.test-result-read"
        on each "required test" as Input "test"
        using "batch" as Input "batch"
        and materializes "test time" from field "testedAt"
        and must establish "every test required by the specification passed on this batch"
      """js
      (
        fact.resultStatus === "pass" ||
        fail("a required QC test did not pass")
      ) &&
      (
        fact.batch === context.batch ||
        fail("a test result belongs to another batch")
      )
      """

  @scenario:cold-chain
  Scenario: Confirm the storage cold chain
    Given scenario "batch-record" is validated
    Then Check "storage" runs Operation "pharma.storage-read"
        on "batch" as Input "batch"
        and must establish "the batch cold chain has no excursion"
      """js
      (
        fact.excursionCount === 0 ||
        fail("the cold chain recorded an excursion")
      ) &&
      (
        fact.peakTemperature <= 8 ||
        fail("the storage temperature exceeded 8 degrees")
      )
      """

  @scenario:deviations
  Scenario: Confirm every deviation is closed with an effective CAPA
    Given scenario "batch-record" is validated
    Then Check "deviation" runs Operation "pharma.deviation-read"
        on each "deviation" as Input "deviation"
        and must establish "every deviation of the batch is closed with an effective CAPA"
      """js
      (
        fact.deviationStatus === "closed" ||
        fail("a deviation is not closed")
      ) &&
      (
        fact.capaStatus === "effective" ||
        fail("a CAPA is not effective")
      ) &&
      (
        fact.batch === context.batch ||
        fail("a deviation belongs to another batch")
      )
      """
    And Check "deviation log" runs Operation "pharma.deviation-log-read"
        on "batch" as Input "batch"
        and must establish "the QMS holds no open deviation the agent did not declare"
      """js
      fact.openDeviationCount === 0 ||
      fail("the QMS still holds an open deviation")
      """

  @scenario:qualified-person
  Scenario: Confirm the Qualified Person authorization for the site
    Given scenario "batch-record" is validated
    Then Check "authorization" runs Operation "pharma.qp-authorization-read"
        on "qualified person" as Input "person"
        using "manufacturing site" as Input "site"
        and materializes "authorization expiry" from field "expiresAt"
        and must establish "the Qualified Person is authorized on the manufacturing site"
      """js
      (
        fact.authorizationStatus === "valid" ||
        fail("the Qualified Person authorization is not valid")
      ) &&
      (
        fact.site === context["manufacturing site"] ||
        fail("the authorization covers another site")
      )
      """

  @scenario:certification
  Scenario: Confirm the batch certification by the Qualified Person
    Given scenario "qc-results" is validated
    And scenario "cold-chain" is validated
    And scenario "deviations" is validated
    And scenario "qualified-person" is validated
    Then Check "certification" runs Operation "pharma.batch-certify"
        on "batch" as Input "batch"
        using "qualified person" as Input "person"
        and must establish "the batch is certified by the authorized Qualified Person"
      """js
      (
        fact.certificationStatus === "certified" ||
        fail("the batch was not certified")
      ) &&
      (
        fact.certifiedBy === context["qualified person"] ||
        fail("the batch was certified by another person")
      ) &&
      (
        fact.certifiedAt < context["authorization expiry"] ||
        fail("the authorization expired before certification")
      ) &&
      (
        context["test time"].every(value => fact.certifiedAt > value) ||
        fail("the certification predates a test result")
      )
      """

  @scenario:release
  Scenario: Confirm the batch release follows the certification
    Given scenario "certification" is validated
    Then Check "release" runs Operation "pharma.batch-read"
        on "batch" as Input "batch"
        and must establish "the batch was released after its certification"
      """js
      (
        fact.batchStatus === "released" ||
        fail("the batch is not released")
      ) &&
      (
        fact.releasedAt > checks.certification.certifiedAt ||
        fail("the release predates the certification")
      )
      """
