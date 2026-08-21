# language: en
@trust-dsl:1 @procedure:hv-work-permit @version:0.1.0
Feature: Run one high-voltage intervention under lockout-tagout with ordered proof

  Electrical consignation (lockout-tagout) on a high-voltage installation. The agent is the
  work-preparation agent: it reads the single-line diagram and the installation registry, derives
  the isolation scheme — which energy sources feed the work zone, including backfeeds and stored
  energy —, generates the isolation instructions, requests the permit and sequences the
  intervention. Deriving a complete isolation scheme from an electrical diagram is engineering
  analysis, not a lookup. What the agent DECLARES is that scheme: the energy sources to isolate.
  What protects the worker is that the declaration is checked against the installation registry
  (a registered source the agent missed fails the Plan), and that every safety fact is observed
  in order:

  - every declared source is locked, and the zero-energy verification of each source comes
    after its isolation;
  - the permit is issued only after every zero-energy verification;
  - the locks are removed only after the work is completed, and the permit is closed after the
    work;
  - the installation is re-energized only after the permit is closed.

  Background: Plan context
    Given one reference "intervention"
    And one reference "installation"
    And many reference "energy source" declared by agent for "installation"
    And many instant "isolation time" for each "energy source"
    And many instant "verification time" for each "energy source"
    And one reference "permit"
    And one instant "work completion time"

  @scenario:source-inventory
  Scenario: Confirm the declared isolation scheme covers the registered sources
    Then Check "registry" runs Operation "energy.installation-read"
        on "installation" as Input "installation"
        and must establish "every registered energy source of the installation was declared"
      | field            | relation | expectation             | failure reason                              |
      | registeredSource | is in    | context "energy source" | "a registered energy source was not declared" |
    And the Scenario is satisfied when every Check is validated

  @scenario:isolation
  Scenario: Confirm every energy source is locked
    Given scenario "source-inventory" is validated
    Then Check "lock" runs Operation "energy.isolation-read"
        on each "energy source" as Input "source"
        and materializes "isolation time" from field "isolatedAt"
        and must establish "every energy source of the scheme is locked"
      | field           | relation | expectation            | failure reason                             |
      | isolationStatus | equals   | value "locked"         | "an energy source is not locked"           |
      | installation    | equals   | context "installation" | "a lock belongs to another installation"   |
    And the Scenario is satisfied when every Check is validated

  @scenario:zero-energy
  Scenario: Confirm the zero-energy verification of every source after its isolation
    Given scenario "isolation" is validated
    # The verifier must also be a DIFFERENT person from the one who applied the lock — same
    # missing `differs from` relation as the aviation duplicate inspection.
    Then Check "verification" runs Operation "energy.zero-energy-read"
        on each "energy source" as Input "source"
        and materializes "verification time" from field "verifiedAt"
        and must establish "every source is verified at zero energy after its isolation"
      | field              | relation | expectation              | failure reason                                  |
      | verificationStatus | equals   | value "verified"         | "a source is not verified at zero energy"       |
      | verifiedAt         | after    | context "isolation time" | "a verification predates its isolation"         |
    And the Scenario is satisfied when every Check is validated

  @scenario:permit
  Scenario: Confirm the work permit was issued after every verification
    Given scenario "zero-energy" is validated
    # DSL GAP — quantified temporal: the permit must be issued after EVERY zero-energy
    # verification. Written here as the missing quantifier `after every`.
    Then Check "permit issue" runs Operation "energy.permit-read"
        on "permit" as Input "permit"
        using "intervention" as Input "intervention"
        and must establish "the work permit was issued after every zero-energy verification"
      | field        | relation    | expectation                 | failure reason                                |
      | permitStatus | equals      | value "issued"              | "the work permit is not issued"               |
      | intervention | equals      | context "intervention"      | "the permit covers another intervention"      |
      | issuedAt     | after every | context "verification time" | "the permit predates a zero-energy verification" |
    And the Scenario is satisfied when every Check is validated

  @scenario:work
  Scenario: Confirm the intervention is completed
    Given scenario "permit" is validated
    Then Check "completion" runs Operation "energy.intervention-read"
        on "intervention" as Input "intervention"
        and materializes "work completion time" from field "completedAt"
        and must establish "the intervention is completed"
      | field              | relation | expectation       | failure reason                     |
      | interventionStatus | equals   | value "completed" | "the intervention is not completed" |
    And the Scenario is satisfied when every Check is validated

  @scenario:deconsignation
  Scenario: Confirm every lock was removed after the work and the permit closed
    Given scenario "work" is validated
    Then Check "lock removal" runs Operation "energy.lock-removal-read"
        on each "energy source" as Input "source"
        and must establish "every lock was removed after the work completion"
      | field         | relation | expectation                    | failure reason                        |
      | removalStatus | equals   | value "removed"                | "a lock is still in place"            |
      | removedAt     | after    | context "work completion time" | "a lock was removed before the work ended" |
    And Check "permit closure" runs Operation "energy.permit-read"
        on "permit" as Input "permit"
        using "intervention" as Input "intervention"
        and must establish "the permit was closed after the work completion"
      | field        | relation | expectation                    | failure reason                          |
      | permitStatus | equals   | value "closed"                 | "the permit is not closed"              |
      | closedAt     | after    | context "work completion time" | "the permit closed before the work ended" |
    And the Scenario is satisfied when every Check is validated

  @scenario:re-energization
  Scenario: Confirm the installation was re-energized after the permit closure
    Given scenario "deconsignation" is validated
    Then Check "re-energization" runs Operation "energy.installation-read"
        on "installation" as Input "installation"
        and must establish "the installation was re-energized after the permit closure"
      | field              | relation | expectation                                    | failure reason                                    |
      | installationStatus | equals   | value "energized"                              | "the installation is not energized"               |
      | energizedAt        | after    | field "closedAt" from Check "permit closure"   | "the re-energization predates the permit closure" |
    And the Scenario is satisfied when every Check is validated
