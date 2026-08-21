# language: en
@trust-dsl:1 @procedure:flight-checklist-conformance @version:0.1.0
Feature: Establish from flight telemetry that every required checklist was actually performed

  Flight data monitoring (FOQA/FDM style) after one flight. The agent is the flight-data analyst
  agent: it digs into the raw telemetry of the flight (QAR parameters: flap handle, trim,
  transponder mode, gear lever, altimeter setting, speed brakes...) and, for each checklist the
  operations manual requires on this flight, locates the telemetry segment whose signature proves
  the checklist actions were really performed — not just ticked in the electronic checklist.
  When it finds no signature, it investigates why (interrupted checklist, phase flown otherwise,
  sensor issue, genuine omission) and files a finding to the safety office. That is analysis
  work across thousands of parameters and an investigation, not a script.

  What the agent DECLARES: per checklist, the telemetry evidence segment it identified; and the
  findings it filed for what it could not evidence. What it can never do:

  - choose the checklists: they come from the operations configuration for the flight;
  - trust the electronic checklist log: the log is compared to the telemetry, the telemetry is
    the proof;
  - validate its own evidence: the declared segment is re-read from the telemetry store and the
    signature match is recomputed there, on the right flight, before the phase gate;
  - leave a checklist unresolved: the assessment system counts every required checklist that has
    neither a matched signature nor a recorded finding, and that count must be zero.

  Background: Plan context
    Given one reference "flight"
    And one reference "aircraft"
    And many reference "required checklist" for "flight"
    And many instant "phase gate time" for each "required checklist"
    And many reference "telemetry evidence" declared by agent for each "required checklist"
    And many reference "finding" declared by agent for "flight"

  @scenario:flight-record
  Scenario: Confirm the flight is closed with complete telemetry
    Then Check "flight" runs Operation "flightops.flight-read"
        on "flight" as Input "flight"
        using "aircraft" as Input "aircraft"
        and must establish "the flight is closed and its telemetry is complete"
      | field             | relation | expectation       | failure reason                            |
      | flightStatus      | equals   | value "closed"    | "the flight is not closed"                |
      | telemetryStatus   | equals   | value "recovered" | "the flight telemetry is not recovered"   |
      | parameterCoverage | at least | number 99         | "the telemetry parameter coverage is too low" |
    And the Scenario is satisfied when every Check is validated

  @scenario:required-checklists
  Scenario: Read the checklists required on this flight from the operations configuration
    Given scenario "flight-record" is validated
    Then Check "ops configuration" runs Operation "flightops.checklist-requirements-read"
        on "flight" as Input "flight"
        using "aircraft" as Input "aircraft"
        and materializes "required checklist" from field "requiredChecklists"
        and must establish "the required checklists of the flight are established by the operations manual"
      | field               | relation | expectation      | failure reason                                 |
      | configurationStatus | equals   | value "resolved" | "the checklist requirements could not be resolved" |
    And the Scenario is satisfied when every Check is validated

  @scenario:phase-gates
  Scenario: Locate the phase gate of every required checklist in the telemetry
    Given scenario "required-checklists" is validated
    Then Check "phase gate" runs Operation "flightops.phase-event-read"
        on each "required checklist" as Input "checklist"
        using "flight" as Input "flight"
        and materializes "phase gate time" from field "gateAt"
        and must establish "the phase gate of every required checklist is detected in the telemetry"
      | field       | relation | expectation      | failure reason                                |
      | phaseStatus | equals   | value "detected" | "a phase gate was not found in the telemetry" |
    And the Scenario is satisfied when every Check is validated

  @scenario:checklist-log
  Scenario: Confirm the electronic checklist log against the phase gates
    Given scenario "phase-gates" is validated
    Then Check "log entry" runs Operation "flightops.checklist-log-read"
        on each "required checklist" as Input "checklist"
        using "flight" as Input "flight"
        and must establish "every required checklist was logged complete before its phase gate"
      | field       | relation | expectation               | failure reason                                  |
      | logStatus   | equals   | value "completed"         | "a checklist was not logged complete"           |
      | completedAt | before   | context "phase gate time" | "a checklist was logged after its phase gate"   |
    And the Scenario is satisfied when every Check is validated

  @scenario:telemetry-evidence
  Scenario: Recompute every declared telemetry signature on the telemetry store
    Given scenario "phase-gates" is validated
    Then Check "signature" runs Operation "flightops.telemetry-signature-read"
        on each "telemetry evidence" as Input "segment"
        using "flight" as Input "flight"
        and must establish "every declared segment proves its checklist in the flight telemetry"
      | field       | relation | expectation                  | failure reason                                       |
      | matchStatus | equals   | value "matched"              | "a declared segment does not match the checklist signature" |
      | checklist   | equals   | context "required checklist" | "a segment is declared for another checklist"        |
      | flight      | equals   | context "flight"             | "a segment belongs to another flight"                |
      | signatureAt | before   | context "phase gate time"    | "the checklist actions happened after the phase gate" |
    And the Scenario is satisfied when every Check is validated

  @scenario:findings
  Scenario: Confirm every finding is investigated and recorded at the safety office
    Given scenario "telemetry-evidence" is validated
    And scenario "checklist-log" is validated
    Then Check "finding" runs Operation "flightops.finding-read"
        on each "finding" as Input "finding"
        and must establish "every finding has an identified cause and reached the safety office"
      | field          | relation | expectation        | failure reason                            |
      | causeStatus    | equals   | value "identified" | "a finding has no identified cause"       |
      | dispatchStatus | equals   | value "recorded"   | "a finding did not reach the safety office" |
      | flight         | equals   | context "flight"   | "a finding belongs to another flight"     |
    And the Scenario is satisfied when every Check is validated

  @scenario:conformance
  Scenario: Confirm every required checklist is either evidenced or covered by a finding
    Given scenario "findings" is validated
    # DSL GAP — alternative satisfaction: the real rule is a disjunction PER CHECKLIST
    # ("matched telemetry signature OR recorded finding"), and Checks only conjoin. The
    # disjunction is therefore computed by the assessment system and observed as one count.
    # Expressing it in the language would need an "either Check A or Check B" form.
    Then Check "assessment" runs Operation "flightops.assessment-read"
        on "flight" as Input "flight"
        and must establish "no required checklist is left without evidence or finding"
      | field                    | relation | expectation | failure reason                                          |
      | unresolvedChecklistCount | equals   | number 0    | "a required checklist has neither evidence nor finding" |
      | openFdmEventCount        | equals   | number 0    | "an auto-detected FDM event was not treated"            |
    And the Scenario is satisfied when every Check is validated
