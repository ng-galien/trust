# language: en
@trust-dsl:1 @procedure:end-to-end-red-green-telemetry @version:1.1.0 @intent-chaining
Feature: Validate a multi-project change through an execution-correlated Red-Green deployment cycle

  Full delivery loop for a defect that touches an acceptance project, library projects and runtime
  projects, driven by one Jira issue. The acceptance project owns the Karate change. Declared library
  projects are installed but are not deployed. Runtime projects are compiled only after their changed library
  dependencies have been installed and their resolved versions have been checked; they are then
  deployed and observed through telemetry. The agent declares the projects, the dependency edges,
  the Karate selection, the runtime images and workloads, one green execution id and one trace for
  each runtime project; every other value is observed by a Check. TRUST also moves the Jira issue
  from `todo` to `in-progress` before repository work and from `in-progress` to `done` after every
  merge. Every project works on a ticket
  branch named after the Jira issue key, cut from its clean `main`, and the Plan ends by merging
  every branch back into `main`, so the operator never branches or merges by hand (local
  repositories only for now: nothing is pushed). Thirteen Scenarios, each one Check per target:

  - jira-issue: the issue is a defect in `todo`.
  - ticket-in-progress: transition the issue exactly from `todo` to `in-progress`.
  - acceptance-baseline: switch the acceptance project to `main`, read its clean HEAD and open the
    ticket branch there.
  - code-baselines: the same for every library and runtime project: clean `main` HEAD, ticket branch
    opened.
  - red: one Operation observes the committed Karate change (ahead of the acceptance baseline,
    clean tree) and runs it in the red phase; the defect must be reproduced. The revision it
    tested becomes the acceptance test revision.
  - library-fix-install: one Operation per library project observes the committed fix (ahead of its
    code baseline, clean tree), installs it with Maven and exposes its exact Maven coordinates.
  - dependency-alignment: one Operation per declared library-to-runtime dependency edge verifies
    that the runtime project resolves the version installed by the related library Check.
  - runtime-fix-verify: only after every dependency edge is aligned, one Operation per runtime
    project observes and compiles the committed fix with Maven.
  - deploy: one Operation per runtime project builds the image from HEAD, loads it into the Kind
    cluster and rolls it out on the declared workload; the built revision must be the runtime fix
    revision.
  - green: the same Karate selection, same acceptance test revision, in the green phase against
    the deployment; it must pass.
  - trace: for every runtime project, the declared trace is read back and must contain a span from
    that project carrying the single declared green execution id.
  - merge: the committed ticket branch of the acceptance project, then of every library and runtime
    project, is merged into `main` with a merge commit and deleted locally; each merge and deletion
    must succeed and leave a clean tree.
  - ticket-done: after every merge, transition the Jira issue exactly from `in-progress` to `done`.

  Every Check runs on the `trust-test` environment: workspace of the projects, jira-mock, Tempo.
  The Plan identifier is passed to Maven as `trust.run` so the Karate traffic of one Plan never
  mixes with another.

  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all   | Change, build, deploy, and verify only the declared projects and issue. | Alter runtime telemetry configuration, collected traces, baselines, or the environment to make a Check pass. |
    Given one reference "jira issue"
    And one string "todo workflow status" fixed as "todo"
    And one string "in-progress workflow status" fixed as "in-progress"
    And one string "done workflow status" fixed as "done"
    And one reference "acceptance project" fixed as "payment-acceptance"
    And one reference "acceptance baseline revision" for "acceptance project"
    And one reference "acceptance test revision" for "acceptance project"
    And one string "test argument" declared by agent for "acceptance project"
    And many reference "library project" declared optionally by agent for "jira issue"
    And many reference "library baseline revision" for each "library project"
    And many reference "library fix revision" for each "library project"
    And many reference "installed library dependency" for each "library project"
    And many reference "runtime dependency project" declared optionally by agent for each "library project"
    And many reference "runtime project" declared by agent
    And many reference "runtime baseline revision" for each "runtime project"
    And many reference "runtime fix revision" for each "runtime project"
    And many reference "planned image" declared by agent for each "runtime project"
    And many reference "workload" declared by agent for each "runtime project"
    And one reference "Kind cluster" fixed as "trust-test"
    And one reference "execution ID" declared by agent
    And one reference "trace" declared by agent for each "runtime project"

  @scenario:acceptance-baseline
  Scenario: Establish the clean acceptance baseline and open its ticket branch
    Given scenario "ticket-in-progress" is validated
    Then Check "acceptance baseline" runs Operation "git.change-start"
        on "acceptance project" as Input "project"
        using "jira issue" as Input "branch"
        and materializes "acceptance baseline revision" from field "baseRevision"
        and must establish "the acceptance project starts the ticket branch from its clean baseline"
      """js
      (
        fact.workingTree === "clean" ||
        fail("the acceptance repository has local changes")
      ) &&
      (
        fact.branch === context["jira issue"] ||
        fail("the acceptance repository is not on the ticket branch")
      )
      """

  @scenario:jira-issue
  Scenario: Read the Jira defect
    Then Check "issue" runs Operation "jira.issue-read"
        on "jira issue" as Input "issue"
        and must establish "the Jira issue is ready for correction"
      """js
      (
        fact.issueType === "defect" ||
        fail("the Jira issue is not a defect")
      ) &&
      (
        fact.workflowStatus === "todo" ||
        fail("the Jira issue is not ready")
      )
      """

  @scenario:ticket-in-progress
  Scenario: Move the Jira issue into progress before repository work
    Given scenario "jira-issue" is validated
    Then Check "start issue" runs Operation "jira.issue-transition"
        on "jira issue" as Input "issue"
        using "todo workflow status" as Input "fromWorkflowStatus"
        using "in-progress workflow status" as Input "toWorkflowStatus"
        and must establish "the Jira issue moved from todo to in-progress"
      """js
      (
        fact.fromWorkflowStatus === context["todo workflow status"] ||
        fail("the Jira issue did not start in todo")
      ) &&
      (
        fact.toWorkflowStatus === context["in-progress workflow status"] ||
        fail("the Jira issue did not move to in-progress")
      )
      """

  @scenario:code-baselines
  Scenario: Establish every clean library and runtime baseline and open its ticket branch
    Given scenario "ticket-in-progress" is validated
    Then Check "library baseline" runs Operation "git.change-start"
        on each "library project" as Input "project"
        using "jira issue" as Input "branch"
        and materializes "library baseline revision" from field "baseRevision"
        and must establish "every library project starts the ticket branch from its clean baseline"
      """js
      (
        fact.workingTree === "clean" ||
        fail("a library project has local changes")
      ) &&
      (
        fact.branch === context["jira issue"] ||
        fail("a library project is not on the ticket branch")
      )
      """
    And Check "runtime baseline" runs Operation "git.change-start"
        on each "runtime project" as Input "project"
        using "jira issue" as Input "branch"
        and materializes "runtime baseline revision" from field "baseRevision"
        and must establish "every runtime project starts the ticket branch from its clean baseline"
      """js
      (
        fact.workingTree === "clean" ||
        fail("a runtime project has local changes")
      ) &&
      (
        fact.branch === context["jira issue"] ||
        fail("a runtime project is not on the ticket branch")
      )
      """

  @scenario:red
  Scenario: Reproduce the defect with the committed Karate change
    Given scenario "ticket-in-progress" is validated
    And scenario "acceptance-baseline" is validated
    Then Check "red run" runs Operation "karate.change-reproduce"
        on "test argument" as Input "testArgument"
        using "acceptance project" as Input "project"
        using "acceptance baseline revision" as Input "baseRevision"
        using "jira issue" as Input "ticket"
        using plan as Input "run"
        and materializes "acceptance test revision" from field "testedRevision"
        and must establish "the committed Karate change reproduces the defect"
      """js
      (
        fact.comparedBaseRevision === context["acceptance baseline revision"] ||
        fail("the Karate change uses another baseline")
      ) &&
      (
        fact.commitsAhead >= 1 ||
        fail("the Karate change is not committed")
      ) &&
      (
        fact.workingTree === "clean" ||
        fail("the acceptance repository has local changes")
      ) &&
      (
        fact.testStatus === "defect-reproduced" ||
        fail("the defect was not reproduced")
      )
      """

  @scenario:library-fix-install
  Scenario: Install every committed library fix with Maven
    Given scenario "red" is validated
    And scenario "code-baselines" is validated
    Then Check "library fix installation" runs Operation "maven.change-install"
        on each "library project" as Input "project"
        using "library baseline revision" as Input "baseRevision"
        using "jira issue" as Input "ticket"
        and materializes "library fix revision" from field "installedRevision"
        and materializes "installed library dependency" from field "installedDependency"
        and must establish "every committed library fix is installed for the runtime builds"
      """js
      (
        fact.comparedBaseRevision === context["library baseline revision"] ||
        fail("a library fix uses another code baseline")
      ) &&
      (
        fact.commitsAhead >= 1 ||
        fail("a library fix is not committed")
      ) &&
      (
        fact.workingTree === "clean" ||
        fail("a library project has local changes")
      ) &&
      (
        fact.installationStatus === "successful" ||
        fail("library Maven installation failed")
      )
      """

  @scenario:dependency-alignment
  Scenario: Confirm every runtime project resolves its installed library versions
    Given scenario "library-fix-install" is validated
    Then Check "runtime dependency alignment" runs Operation "maven.dependency-verify"
        on each "runtime dependency project" as Input "project"
        using "installed library dependency" as Input "dependency"
        and must establish "every declared runtime dependency resolves the installed library version"
      """js
      (
        context["runtime project"].includes(fact.project) ||
        fail("a dependency edge targets a project that is not a declared runtime project")
      ) &&
      (
        fact.dependencyStatus === "aligned" ||
        fail("a runtime project does not resolve the installed library version")
      )
      """

  @scenario:runtime-fix-verify
  Scenario: Verify every committed runtime fix with Maven after library installation
    Given scenario "red" is validated
    And scenario "library-fix-install" is validated
    And scenario "dependency-alignment" is validated
    Then Check "runtime fix verification" runs Operation "maven.change-verify"
        on each "runtime project" as Input "project"
        using "runtime baseline revision" as Input "baseRevision"
        using "jira issue" as Input "ticket"
        and materializes "runtime fix revision" from field "verifiedRevision"
        and must establish "every committed runtime fix passes Maven verification"
      """js
      (
        fact.comparedBaseRevision === context["runtime baseline revision"] ||
        fail("a runtime fix uses another code baseline")
      ) &&
      (
        fact.commitsAhead >= 1 ||
        fail("a runtime fix is not committed")
      ) &&
      (
        fact.workingTree === "clean" ||
        fail("a runtime project has local changes")
      ) &&
      (
        fact.verificationStatus === "successful" ||
        fail("runtime Maven verification failed")
      )
      """

  @scenario:deploy
  Scenario: Build, load and roll out every runtime fix on Kind
    Given scenario "runtime-fix-verify" is validated
    Then Check "deployment" runs Operation "kind.change-deploy"
        on each "runtime project" as Input "project"
        using "planned image" as Input "image"
        using "Kind cluster" as Input "cluster"
        using "workload" as Input "workload"
        and must establish "every runtime fix is built, loaded into Kind and rolled out"
      """js
      (
        fact.builtRevision === context["runtime fix revision"] ||
        fail("the image was built from another revision")
      ) &&
      (
        fact.deployStatus === "successful" ||
        fail("the build, the Kind load or the rollout failed")
      )
      """

  @scenario:green
  Scenario: Confirm the Karate change against the deployment
    Given scenario "red" is validated
    And scenario "deploy" is validated
    Then Check "green run" runs Operation "karate.change-verify"
        on "test argument" as Input "testArgument"
        using "acceptance project" as Input "project"
        using "acceptance baseline revision" as Input "baseRevision"
        using "jira issue" as Input "ticket"
        using plan as Input "run"
        and must establish "the Karate change passes against the deployment"
      """js
      (
        fact.testedRevision === context["acceptance test revision"] ||
        fail("the green run used another test revision")
      ) &&
      (
        fact.testStatus === "successful" ||
        fail("the deployed acceptance test failed")
      )
      """

  @scenario:trace
  Scenario: Confirm every runtime project in the green execution traces
    Given scenario "green" is validated
    Then Check "green trace" runs Operation "telemetry.project-trace-read"
        on each "runtime project" as Input "project"
        using "trace" as Input "traceId"
        using "execution ID" as Input "executionId"
        and must establish "every runtime project appears in its declared green execution trace"
      """js
      fact.matchingSpanCount >= 1 ||
      fail("the declared trace has no span for the runtime project and green execution")
      """

  @scenario:merge
  Scenario: Merge every ticket branch into main
    Given scenario "green" is validated
    And scenario "trace" is validated
    Then Check "acceptance merge" runs Operation "git.change-merge"
        on "acceptance project" as Input "project"
        using "jira issue" as Input "branch"
        using "jira issue" as Input "ticket"
        and must establish "the acceptance change is merged into main"
      """js
      (
        fact.mergeStatus === "merged" ||
        fail("the acceptance ticket branch did not merge into main")
      ) &&
      (
        fact.branchStatus === "deleted" ||
        fail("the acceptance ticket branch still exists locally")
      ) &&
      (
        fact.workingTree === "clean" ||
        fail("the acceptance repository has local changes")
      )
      """
    And Check "library merge" runs Operation "git.change-merge"
        on each "library project" as Input "project"
        using "jira issue" as Input "branch"
        using "jira issue" as Input "ticket"
        and must establish "every library fix is merged into main"
      """js
      (
        fact.mergeStatus === "merged" ||
        fail("a library ticket branch did not merge into main")
      ) &&
      (
        fact.branchStatus === "deleted" ||
        fail("a library ticket branch still exists locally")
      ) &&
      (
        fact.workingTree === "clean" ||
        fail("a library project has local changes")
      )
      """
    And Check "runtime merge" runs Operation "git.change-merge"
        on each "runtime project" as Input "project"
        using "jira issue" as Input "branch"
        using "jira issue" as Input "ticket"
        and must establish "every runtime fix is merged into main"
      """js
      (
        fact.mergeStatus === "merged" ||
        fail("a runtime ticket branch did not merge into main")
      ) &&
      (
        fact.branchStatus === "deleted" ||
        fail("a runtime ticket branch still exists locally")
      ) &&
      (
        fact.workingTree === "clean" ||
        fail("a runtime project has local changes")
      )
      """

  @scenario:ticket-done
  Scenario: Move the Jira issue to done after every merge
    Given scenario "merge" is validated
    Then Check "done issue" runs Operation "jira.issue-transition"
        on "jira issue" as Input "issue"
        using "in-progress workflow status" as Input "fromWorkflowStatus"
        using "done workflow status" as Input "toWorkflowStatus"
        and must establish "the Jira issue moved from in-progress to done"
      """js
      (
        fact.fromWorkflowStatus === context["in-progress workflow status"] ||
        fail("the Jira issue did not start in-progress")
      ) &&
      (
        fact.toWorkflowStatus === context["done workflow status"] ||
        fail("the Jira issue did not move to done")
      )
      """
