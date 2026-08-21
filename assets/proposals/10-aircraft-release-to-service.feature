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
      | field                  | relation | expectation            | failure reason                          |
      | aircraftStatus         | equals   | value "in-maintenance" | "the aircraft is not in maintenance"    |
      | overdueDirectiveCount  | equals   | number 0               | "an airworthiness directive is overdue" |
    And the Scenario is satisfied when every Check is validated

  @scenario:work-orders
  Scenario: Confirm every work order of the visit is closed
    Given scenario "airworthiness" is validated
    Then Check "visit closure" runs Operation "aviation.visit-read"
        on "maintenance visit" as Input "visit"
        using "aircraft" as Input "aircraft"
        and must establish "the maintenance visit has no open work order"
      | field              | relation | expectation | failure reason                                  |
      | openWorkOrderCount | equals   | number 0    | "the visit still has an open work order"        |
    And Check "work order" runs Operation "aviation.work-order-read"
        on each "work order" as Input "workOrder"
        and must establish "every declared work order is closed on this visit"
      | field           | relation | expectation                 | failure reason                                |
      | workOrderStatus | equals   | value "closed"              | "a declared work order is not closed"         |
      | visit           | equals   | context "maintenance visit" | "a work order belongs to another visit"       |
    And the Scenario is satisfied when every Check is validated

  @scenario:part-certificates
  Scenario: Confirm one valid release certificate per fitted part
    Given scenario "work-orders" is validated
    Then Check "part certificate" runs Operation "aviation.part-certificate-read"
        on each "fitted part" as Input "part"
        and materializes "certificate release time" from field "releasedAt"
        and must establish "every fitted part carries a valid release certificate for its serial"
      | field             | relation | expectation           | failure reason                                     |
      | certificateStatus | equals   | value "valid"         | "a part has no valid release certificate"          |
      | certifiedSerial   | equals   | context "fitted part" | "a certificate covers another serial number"       |
    And the Scenario is satisfied when every Check is validated

  @scenario:part-fitment
  Scenario: Confirm every part was fitted after its certificate release
    Given scenario "part-certificates" is validated
    Then Check "fitment" runs Operation "aviation.part-fitment-read"
        on each "fitted part" as Input "part"
        and must establish "every part fitment is recorded after its certificate release"
      | field         | relation | expectation                        | failure reason                                |
      | fitmentStatus | equals   | value "recorded"                   | "a part fitment is not recorded"              |
      | workOrder     | equals   | context "work order"               | "a part is fitted under another work order"   |
      | fittedAt      | after    | context "certificate release time" | "a part was fitted before its certificate"    |
    And the Scenario is satisfied when every Check is validated

  @scenario:duplicate-inspection
  Scenario: Confirm the independent duplicate inspection of every flight-control task
    Given scenario "work-orders" is validated
    # DSL GAP — "differs from": the regulation requires the inspector to be a DIFFERENT person
    # from the mechanic who performed the task (independence / four-eyes). The relation set has
    # no inequality. Written here as the missing relation `differs from`.
    Then Check "independent inspection" runs Operation "aviation.inspection-read"
        on each "duplicate inspection task" as Input "task"
        and must establish "every flight-control task passed an independent duplicate inspection"
      | field            | relation     | expectation             | failure reason                                       |
      | inspectionStatus | equals       | value "passed"          | "a duplicate inspection did not pass"                |
      | inspectorLicence | differs from | field "mechanicLicence" | "a task was inspected by the person who performed it" |
    And the Scenario is satisfied when every Check is validated

  @scenario:signing-engineer
  Scenario: Confirm the signing engineer licence covers the aircraft type
    Given scenario "airworthiness" is validated
    Then Check "licence" runs Operation "aviation.licence-read"
        on "signing engineer" as Input "engineer"
        using "aircraft" as Input "aircraft"
        and materializes "licence expiry" from field "expiresAt"
        and must establish "the signing engineer holds a valid licence covering the type"
      | field            | relation | expectation   | failure reason                                    |
      | licenceStatus    | equals   | value "valid" | "the signing engineer licence is not valid"       |
      | typeRatingStatus | equals   | value "valid" | "the licence does not cover this aircraft type"   |
    And the Scenario is satisfied when every Check is validated

  @scenario:release-certificate
  Scenario: Confirm the certificate of release to service
    Given scenario "part-fitment" is validated
    And scenario "duplicate-inspection" is validated
    And scenario "signing-engineer" is validated
    # DSL GAP — quantified temporal: the signature must come after EVERY work order closure
    # (a one-instant field compared against a many-instant role). Written here as the missing
    # quantifier `after every`.
    Then Check "crs" runs Operation "aviation.release-record"
        on "maintenance visit" as Input "visit"
        using "aircraft" as Input "aircraft"
        using "signing engineer" as Input "engineer"
        and must establish "the certificate of release to service is signed under a valid licence"
      | field     | relation    | expectation                  | failure reason                                     |
      | crsStatus | equals      | value "issued"               | "the release certificate was not issued"           |
      | signedBy  | equals      | context "signing engineer"   | "the certificate was signed by another engineer"   |
      | signedAt  | before      | context "licence expiry"     | "the licence expired before the signature"         |
      | signedAt  | after every | context "work order closure" | "the certificate predates a work order closure"    |
    And the Scenario is satisfied when every Check is validated

  @scenario:back-in-service
  Scenario: Confirm the aircraft is serviceable after the release certificate
    Given scenario "release-certificate" is validated
    Then Check "serviceability" runs Operation "aviation.aircraft-status-read"
        on "aircraft" as Input "aircraft"
        and must establish "the aircraft returned to service after its release certificate"
      | field           | relation | expectation                          | failure reason                                  |
      | aircraftStatus  | equals   | value "serviceable"                  | "the aircraft is not serviceable"               |
      | statusChangedAt | after    | field "signedAt" from Check "crs"    | "the aircraft returned to service before the certificate" |
    And the Scenario is satisfied when every Check is validated
