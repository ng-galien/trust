# language: en
@trust-dsl:1 @procedure:aircraft-release-to-service @version:0.1.0
Feature: Release one aircraft to service after a maintenance visit

  Part-145 style release to service. The agent is the maintenance-records agent of the visit: it
  reads the work package in the maintenance system, reconciles part movements with the stores
  system, chases the missing release certificates, decides which tasks touch flight controls and
  therefore require an independent duplicate inspection, assembles the release dossier and routes
  it to the signing engineer. None of that is scriptable: it is document analysis, cross-system
  reconciliation and regulatory judgment. What the agent DECLARES to the Plan is the outcome of
  that judgment: the work orders of the visit, the fitted parts, the duplicate-inspection tasks,
  the signing engineer. What the agent can never do is validate its own dossier: every fact is
  re-read from the maintenance, parts and licensing systems by a Check:

  - no overdue airworthiness directive on the aircraft;
  - every declared work order is closed, and the visit has no open work order the agent did not
    declare;
  - every fitted part carries one valid release certificate (Form 1 style) whose serial number
    matches the part, and the fitment was recorded after the certificate release;
  - every flight-control task passed an independent duplicate inspection, performed by a person
    different from the one who did the work;
  - the signing engineer holds a valid licence covering the aircraft type, and signs the
    certificate of release to service while that licence is valid;
  - the aircraft returns to serviceable state only after the release certificate is signed.

  Background: Plan context
    Given one reference "aircraft"
    And one reference "maintenance visit"
    And many reference "work order" declared by agent for "maintenance visit"
    And many reference "fitted part" declared by agent for each "work order"
    And many instant "certificate release time" for each "fitted part"
    And many reference "duplicate inspection task" declared by agent for "maintenance visit"
    And one reference "signing engineer" declared by agent
    And one instant "licence expiry"

  @scenario:airworthiness
  Scenario: Confirm the aircraft is in maintenance with no overdue directive
    Then Check "aircraft status" runs Operation "aviation.aircraft-status-read"
        on "aircraft" as Input "aircraft"
        and must establish "the aircraft is in maintenance with no overdue airworthiness directive"
      """js
      (
        fact.aircraftStatus === "in-maintenance" ||
        fail("the aircraft is not in maintenance")
      ) &&
      (
        fact.overdueDirectiveCount === 0 ||
        fail("an airworthiness directive is overdue")
      )
      """

  @scenario:work-orders
  Scenario: Confirm every work order of the visit is closed
    Given scenario "airworthiness" is validated
    Then Check "visit closure" runs Operation "aviation.visit-read"
        on "maintenance visit" as Input "visit"
        using "aircraft" as Input "aircraft"
        and must establish "the maintenance visit has no open work order"
      """js
      fact.openWorkOrderCount === 0 ||
      fail("the visit still has an open work order")
      """
    And Check "work order" runs Operation "aviation.work-order-read"
        on each "work order" as Input "workOrder"
        and must establish "every declared work order is closed on this visit"
      """js
      (
        fact.workOrderStatus === "closed" ||
        fail("a declared work order is not closed")
      ) &&
      (
        fact.visit === context["maintenance visit"] ||
        fail("a work order belongs to another visit")
      )
      """

  @scenario:part-certificates
  Scenario: Confirm one valid release certificate per fitted part
    Given scenario "work-orders" is validated
    Then Check "part certificate" runs Operation "aviation.part-certificate-read"
        on each "fitted part" as Input "part"
        and materializes "certificate release time" from field "releasedAt"
        and must establish "every fitted part carries a valid release certificate for its serial"
      """js
      (
        fact.certificateStatus === "valid" ||
        fail("a part has no valid release certificate")
      ) &&
      (
        fact.certifiedSerial === context["fitted part"] ||
        fail("a certificate covers another serial number")
      )
      """

  @scenario:part-fitment
  Scenario: Confirm every part was fitted after its certificate release
    Given scenario "part-certificates" is validated
    Then Check "fitment" runs Operation "aviation.part-fitment-read"
        on each "fitted part" as Input "part"
        and must establish "every part fitment is recorded after its certificate release"
      """js
      (
        fact.fitmentStatus === "recorded" ||
        fail("a part fitment is not recorded")
      ) &&
      (
        fact.workOrder === context["work order"] ||
        fail("a part is fitted under another work order")
      ) &&
      (
        fact.fittedAt > context["certificate release time"] ||
        fail("a part was fitted before its certificate")
      )
      """

  @scenario:duplicate-inspection
  Scenario: Confirm the independent duplicate inspection of every flight-control task
    Given scenario "work-orders" is validated
    Then Check "independent inspection" runs Operation "aviation.inspection-read"
        on each "duplicate inspection task" as Input "task"
        and must establish "every flight-control task passed an independent duplicate inspection"
      """js
      (
        fact.inspectionStatus === "passed" ||
        fail("a duplicate inspection did not pass")
      ) &&
      (
        fact.inspectorLicence !== fact.mechanicLicence ||
        fail("a task was inspected by the person who performed it")
      )
      """

  @scenario:signing-engineer
  Scenario: Confirm the signing engineer licence covers the aircraft type
    Given scenario "airworthiness" is validated
    Then Check "licence" runs Operation "aviation.licence-read"
        on "signing engineer" as Input "engineer"
        using "aircraft" as Input "aircraft"
        and materializes "licence expiry" from field "expiresAt"
        and must establish "the signing engineer holds a valid licence covering the type"
      """js
      (
        fact.licenceStatus === "valid" ||
        fail("the signing engineer licence is not valid")
      ) &&
      (
        fact.typeRatingStatus === "valid" ||
        fail("the licence does not cover this aircraft type")
      )
      """

  @scenario:release-certificate
  Scenario: Confirm the certificate of release to service
    Given scenario "part-fitment" is validated
    And scenario "duplicate-inspection" is validated
    And scenario "signing-engineer" is validated
    Then Check "crs" runs Operation "aviation.release-record"
        on "maintenance visit" as Input "visit"
        using "aircraft" as Input "aircraft"
        using "signing engineer" as Input "engineer"
        and must establish "the certificate of release to service is signed under a valid licence"
      """js
      (
        fact.crsStatus === "issued" ||
        fail("the release certificate was not issued")
      ) &&
      (
        fact.signedBy === context["signing engineer"] ||
        fail("the certificate was signed by another engineer")
      ) &&
      (
        fact.signedAt < context["licence expiry"] ||
        fail("the licence expired before the signature")
      ) &&
      (
        context["work order closure"].every(value => fact.signedAt > value) ||
        fail("the certificate predates a work order closure")
      )
      """

  @scenario:back-in-service
  Scenario: Confirm the aircraft is serviceable after the release certificate
    Given scenario "release-certificate" is validated
    Then Check "serviceability" runs Operation "aviation.aircraft-status-read"
        on "aircraft" as Input "aircraft"
        and must establish "the aircraft returned to service after its release certificate"
      """js
      (
        fact.aircraftStatus === "serviceable" ||
        fail("the aircraft is not serviceable")
      ) &&
      (
        fact.statusChangedAt > checks.crs.signedAt ||
        fail("the aircraft returned to service before the certificate")
      )
      """
