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
      """js
      context["energy source"].includes(fact.registeredSource) ||
      fail("a registered energy source was not declared")
      """

  @scenario:isolation
  Scenario: Confirm every energy source is locked
    Given scenario "source-inventory" is validated
    Then Check "lock" runs Operation "energy.isolation-read"
        on each "energy source" as Input "source"
        and materializes "isolation time" from field "isolatedAt"
        and must establish "every energy source of the scheme is locked"
      """js
      (
        fact.isolationStatus === "locked" ||
        fail("an energy source is not locked")
      ) &&
      (
        fact.installation === context.installation ||
        fail("a lock belongs to another installation")
      )
      """

  @scenario:zero-energy
  Scenario: Confirm the zero-energy verification of every source after its isolation
    Given scenario "isolation" is validated
    Then Check "verification" runs Operation "energy.zero-energy-read"
        on each "energy source" as Input "source"
        and materializes "verification time" from field "verifiedAt"
        and must establish "every source is verified at zero energy after its isolation"
      """js
      (
        fact.verificationStatus === "verified" ||
        fail("a source is not verified at zero energy")
      ) &&
      (
        fact.verifiedAt > context["isolation time"] ||
        fail("a verification predates its isolation")
      )
      """

  @scenario:permit
  Scenario: Confirm the work permit was issued after every verification
    Given scenario "zero-energy" is validated
    Then Check "permit issue" runs Operation "energy.permit-read"
        on "permit" as Input "permit"
        using "intervention" as Input "intervention"
        and must establish "the work permit was issued after every zero-energy verification"
      """js
      (
        fact.permitStatus === "issued" ||
        fail("the work permit is not issued")
      ) &&
      (
        fact.intervention === context.intervention ||
        fail("the permit covers another intervention")
      ) &&
      (
        context["verification time"].every(value => fact.issuedAt > value) ||
        fail("the permit predates a zero-energy verification")
      )
      """

  @scenario:work
  Scenario: Confirm the intervention is completed
    Given scenario "permit" is validated
    Then Check "completion" runs Operation "energy.intervention-read"
        on "intervention" as Input "intervention"
        and materializes "work completion time" from field "completedAt"
        and must establish "the intervention is completed"
      """js
      fact.interventionStatus === "completed" ||
      fail("the intervention is not completed")
      """

  @scenario:deconsignation
  Scenario: Confirm every lock was removed after the work and the permit closed
    Given scenario "work" is validated
    Then Check "lock removal" runs Operation "energy.lock-removal-read"
        on each "energy source" as Input "source"
        and must establish "every lock was removed after the work completion"
      """js
      (
        fact.removalStatus === "removed" ||
        fail("a lock is still in place")
      ) &&
      (
        fact.removedAt > context["work completion time"] ||
        fail("a lock was removed before the work ended")
      )
      """
    And Check "permit closure" runs Operation "energy.permit-read"
        on "permit" as Input "permit"
        using "intervention" as Input "intervention"
        and must establish "the permit was closed after the work completion"
      """js
      (
        fact.permitStatus === "closed" ||
        fail("the permit is not closed")
      ) &&
      (
        fact.closedAt > context["work completion time"] ||
        fail("the permit closed before the work ended")
      )
      """

  @scenario:re-energization
  Scenario: Confirm the installation was re-energized after the permit closure
    Given scenario "deconsignation" is validated
    Then Check "re-energization" runs Operation "energy.installation-read"
        on "installation" as Input "installation"
        and must establish "the installation was re-energized after the permit closure"
      """js
      (
        fact.installationStatus === "energized" ||
        fail("the installation is not energized")
      ) &&
      (
        fact.energizedAt > checks["permit closure"].closedAt ||
        fail("the re-energization predates the permit closure")
      )
      """
