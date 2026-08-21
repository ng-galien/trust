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
      """js
      (
        fact.flightStatus === "closed" ||
        fail("the flight is not closed")
      ) &&
      (
        fact.telemetryStatus === "recovered" ||
        fail("the flight telemetry is not recovered")
      ) &&
      (
        fact.parameterCoverage >= 99 ||
        fail("the telemetry parameter coverage is too low")
      )
      """

  @scenario:required-checklists
  Scenario: Read the checklists required on this flight from the operations configuration
    Given scenario "flight-record" is validated
    Then Check "ops configuration" runs Operation "flightops.checklist-requirements-read"
        on "flight" as Input "flight"
        using "aircraft" as Input "aircraft"
        and materializes "required checklist" from field "requiredChecklists"
        and must establish "the required checklists of the flight are established by the operations manual"
      """js
      fact.configurationStatus === "resolved" ||
      fail("the checklist requirements could not be resolved")
      """

  @scenario:phase-gates
  Scenario: Locate the phase gate of every required checklist in the telemetry
    Given scenario "required-checklists" is validated
    Then Check "phase gate" runs Operation "flightops.phase-event-read"
        on each "required checklist" as Input "checklist"
        using "flight" as Input "flight"
        and materializes "phase gate time" from field "gateAt"
        and must establish "the phase gate of every required checklist is detected in the telemetry"
      """js
      fact.phaseStatus === "detected" ||
      fail("a phase gate was not found in the telemetry")
      """

  @scenario:checklist-log
  Scenario: Confirm the electronic checklist log against the phase gates
    Given scenario "phase-gates" is validated
    Then Check "log entry" runs Operation "flightops.checklist-log-read"
        on each "required checklist" as Input "checklist"
        using "flight" as Input "flight"
        and must establish "every required checklist was logged complete before its phase gate"
      """js
      (
        fact.logStatus === "completed" ||
        fail("a checklist was not logged complete")
      ) &&
      (
        fact.completedAt < context["phase gate time"] ||
        fail("a checklist was logged after its phase gate")
      )
      """

  @scenario:telemetry-evidence
  Scenario: Recompute every declared telemetry signature on the telemetry store
    Given scenario "phase-gates" is validated
    Then Check "signature" runs Operation "flightops.telemetry-signature-read"
        on each "telemetry evidence" as Input "segment"
        using "flight" as Input "flight"
        and must establish "every declared segment proves its checklist in the flight telemetry"
      """js
      (
        fact.matchStatus === "matched" ||
        fail("a declared segment does not match the checklist signature")
      ) &&
      (
        fact.checklist === context["required checklist"] ||
        fail("a segment is declared for another checklist")
      ) &&
      (
        fact.flight === context.flight ||
        fail("a segment belongs to another flight")
      ) &&
      (
        fact.signatureAt < context["phase gate time"] ||
        fail("the checklist actions happened after the phase gate")
      )
      """

  @scenario:findings
  Scenario: Confirm every finding is investigated and recorded at the safety office
    Given scenario "telemetry-evidence" is validated
    And scenario "checklist-log" is validated
    Then Check "finding" runs Operation "flightops.finding-read"
        on each "finding" as Input "finding"
        and must establish "every finding has an identified cause and reached the safety office"
      """js
      (
        fact.causeStatus === "identified" ||
        fail("a finding has no identified cause")
      ) &&
      (
        fact.dispatchStatus === "recorded" ||
        fail("a finding did not reach the safety office")
      ) &&
      (
        fact.flight === context.flight ||
        fail("a finding belongs to another flight")
      )
      """

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
      """js
      (
        fact.unresolvedChecklistCount === 0 ||
        fail("a required checklist has neither evidence nor finding")
      ) &&
      (
        fact.openFdmEventCount === 0 ||
        fail("an auto-detected FDM event was not treated")
      )
      """
