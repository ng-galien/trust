import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { SCOPE, startWorkspace } from "./acceptance-operations-support.mjs";

const exec = promisify(execFile);
const trust = fileURLToPath(new URL("../", import.meta.url));
const SCRIPT = path.join(trust, "scripts/delegation-topology.mjs");
// The library reports its wiring refusals with elaboration-time $error, which Icarus Verilog evaluates from version 13.
const icarus = await promisify(execFile)("iverilog", ["-V"]).then(
  ({ stdout }) => {
    const major = Number(/Icarus Verilog version (\d+)/u.exec(stdout)?.[1]);
    return major >= 13 ? false : `Icarus Verilog 13 is required, found ${stdout.split("\n")[0]}`;
  },
  () => "Icarus Verilog is not installed",
);
const CASES = "assets/delegation/cases";
const ELEMENTS = [
  "mission",
  "mission_interface",
  "analysis",
  "consolidation",
  "batch",
  "resource",
  "coverage",
  "coordinator",
  "owner",
  "delivery",
];
const ANALYSES = ["survey-runtime", "survey-store", "survey-ui"];

/** Runs the check as a process from the repository root and returns its stdout and parsed result. */
const check = async (name, missions) => {
  const data = missions ? ["--missions", `${CASES}/${missions}`] : [];
  const { stdout } = await exec(process.execPath, [SCRIPT, "check", `${CASES}/${name}.sv`, ...data], { cwd: trust });
  return { stdout, result: JSON.parse(stdout) };
};
const refused = (stage, reason) => ({
  accepted: false,
  stage,
  reason,
  missions: [],
  decisions: [],
  delivery: [],
  structure: [],
});

const ACCEPTED_C1 = {
  accepted: true,
  stage: "accepted",
  reason: "the topology is wired and delivered",
  missions: [
    {
      id: "declared-delivery",
      definition: { kind: "published", reference: "delegation-code@2.0.0" },
      rootInputs: { mission: "declared-delivery", assignee: "agent-1", reviewer: "agent-2" },
    },
    {
      id: "plan-card",
      definition: { kind: "published", reference: "delegation-interface@3.0.0" },
      rootInputs: { mission: "plan-card", assignee: "agent-2", reviewer: "agent-1" },
    },
  ],
  decisions: [{ mission: "plan-card", owner: "visual validation" }],
  delivery: [
    {
      id: "delivery",
      definition: { kind: "published", reference: "delivery-git@1.0.0" },
      rootInputs: { project: "trust" },
    },
  ],
  structure: [
    {
      mission: "declared-delivery",
      kind: "mission",
      criteria: ["ORG-130.AC1", "ORG-130.AC2"],
      batch: null,
      start: 1,
      complete: 15,
      after: [],
    },
    {
      mission: "plan-card",
      kind: "interface",
      criteria: ["CXP-250.AC1"],
      batch: null,
      start: 1,
      complete: 13,
      after: [],
    },
  ],
};

const probe = `@trust-dsl:1 @procedure:topology-probe @version:1.0.0
Feature: Check one delegation topology of the workspace
  Background: Plan context
${SCOPE}
    And one string "topology"
    And one string "missions"

  @scenario:topology
  Scenario: Check the topology
    Then Check "check topology" runs Operation "delegation.topology-check@1.0.0"
      on "topology" as Input "topology"
      using "missions" as Input "missions"
      and must establish "the topology is accepted"
      """js
      fact.accepted === 1 || fail(fact.reason)
      """
`;
/** The test Procedures that case c15 names: a delegated work, a delivery, and a parent whose agent declares both. */
const work = `@trust-dsl:1 @procedure:topology-work @version:1.0.0
Feature: Do one delegated work of a topology
  Background: Plan context
${SCOPE}
    And one string "mission"
    And one string "assignee"
    And one string "reviewer"
    And one string "facet"
    And one string "instructions"
    And one string "acceptance verification"

  @scenario:work
  Scenario: Check the work
    Then Check "check work" runs Operation "delegation.topology-check@1.0.0"
      on "instructions" as Input "topology"
      using "facet" as Input "missions"
      and must establish "the work is checked"
      """js
      fact.accepted === 1 || fail(fact.reason)
      """
`;
const deliver = `@trust-dsl:1 @procedure:topology-delivery @version:1.0.0
Feature: Deliver the work of a topology
  Background: Plan context
${SCOPE}
    And one string "project"

  @scenario:delivery
  Scenario: Check the delivery
    Then Check "check delivery" runs Operation "delegation.topology-check@1.0.0"
      on "project" as Input "topology"
      using "project" as Input "missions"
      and must establish "the delivery is checked"
      """js
      fact.accepted === 1 || fail(fact.reason)
      """
`;
const parent = `@trust-dsl:1 @procedure:topology-parent @version:1.0.0
Feature: Run the work and the delivery a topology declares
  Background: Plan context
${SCOPE}
    And missions "work" declared by agent
    And missions "delivery" declared by agent

  @scenario:work
  Scenario: Execute declared work
    Then Invocation "execute-work" runs each declared Procedure in "work" and must establish "declared work completed"

  @scenario:delivery
  Scenario: Deliver the work
    Then Invocation "deliver" runs each declared Procedure in "delivery" and must establish "the work is delivered"
`;

/** A runtime whose workspace holds the check helper, the library, the bench and the cases, and the probe Procedure. */
let workspace;
before(async () => {
  workspace = await startWorkspace("delegation-topology-", {
    helpers: ["delegation-topology.mjs"],
    operations: ["drafts/delegation.topology-check.feature"],
  });
  const files = ["library.sv", "bench.sv", ...(await readdir(path.join(trust, CASES))).map((name) => `cases/${name}`)];
  for (const file of files)
    await workspace.write(`assets/delegation/${file}`, await readFile(path.join(trust, "assets/delegation", file)));
  for (const source of [probe, work, deliver, parent]) await workspace.publish(source);
});
after(() => workspace?.close());

test("TOPO-010 AC1 the library provides the elements mission, mission_interface, analysis, consolidation, batch, resource, coverage, coordinator, owner and delivery", {
  skip: icarus,
}, async () => {
  const library = await readFile(path.join(trust, "assets/delegation/library.sv"), "utf8");
  const modules = [...library.matchAll(/^module (\w+)/gmu)].map((match) => match[1]);
  assert.deepEqual([...modules].sort(), [...ELEMENTS].sort());
  // Together the accepted cases wire every element of the library.
  const used = new Set();
  for (const name of [
    "c1_interface_validated_by_the_owner",
    "c2_same_files_in_sequence",
    "c4_nested_delegation",
    "c33_analysis_and_consolidation",
  ]) {
    assert.equal((await check(name)).result.accepted, true, name);
    const source = await readFile(path.join(trust, CASES, `${name}.sv`), "utf8");
    for (const element of ELEMENTS) if (new RegExp(`^\\s*${element}\\b`, "mu").test(source)) used.add(element);
  }
  assert.deepEqual([...used].sort(), [...ELEMENTS].sort());
});

test("TOPO-040 AC1 the library provides the analysis element, a mission that returns findings and has no busy output", {
  skip: icarus,
}, async () => {
  const library = await readFile(path.join(trust, "assets/delegation/library.sv"), "utf8");
  const header = /^module analysis [\s\S]*?\);/mu.exec(library)[0];
  for (const parameter of ["ID", "PROCEDURE", "ASSIGNEE", "REVIEWER", "CRITERIA", "DURATION"])
    assert.match(header, new RegExp(`parameter ${parameter} =`, "u"), parameter);
  for (const port of ["clk", "start", "decision", "request", "complete", "covers"])
    assert.match(header, new RegExp(`\\b${port}\\b`, "u"), port);
  assert.doesNotMatch(header, /\bbusy\b/u);
  // An analysis is declared as a mission of its Procedure, with its assignee and reviewer, and its kind in the order.
  const { result } = await check("c33_analysis_and_consolidation");
  assert.equal(result.accepted, true, result.reason);
  const analyses = result.missions.filter((mission) => ANALYSES.includes(mission.id));
  assert.deepEqual(
    analyses.map(({ id, definition, rootInputs }) => [
      id,
      definition.reference,
      rootInputs.assignee,
      rootInputs.reviewer,
    ]),
    [
      ["survey-runtime", "delegation-code@2.0.0", "agent-3", "agent-2"],
      ["survey-store", "delegation-code@2.0.0", "agent-4", "agent-2"],
      ["survey-ui", "delegation-code@2.0.0", "agent-1", "agent-2"],
    ],
  );
  assert.deepEqual(
    result.structure.map(({ mission, kind, criteria }) => [mission, kind, criteria]),
    [
      ["apply-findings", "mission", ["ANA-1.AC4"]],
      ["survey-runtime", "analysis", ["ANA-1.AC2"]],
      ["survey-store", "analysis", ["ANA-1.AC3"]],
      ["survey-ui", "analysis", ["ANA-1.AC1"]],
    ],
  );
  // Its busy output does not exist, and the topology names the Procedure of each analysis.
  assert.deepEqual(
    (await check("c45_analysis_busy")).result,
    refused("wiring", "topology.sv:8: error: port ``busy'' is not a port of a1."),
  );
  assert.deepEqual(
    (await check("c35_analysis_without_procedure")).result,
    refused(
      "wiring",
      "ERROR: library.sv:124: analysis survey-store: the procedure is empty; a topology names the Procedure of each analysis",
    ),
  );
});

test("TOPO-040 AC2 the library provides the consolidation element, complete when each mission it receives is complete", {
  skip: icarus,
}, async () => {
  const { result } = await check("c33_analysis_and_consolidation");
  assert.equal(result.accepted, true, result.reason);
  const entry = (id) => result.structure.find((item) => item.mission === id);
  // The analyses end at different times; the mission the consolidation starts begins only after the last one.
  assert.deepEqual(
    ANALYSES.map((id) => entry(id).complete),
    [8, 11, 5],
  );
  assert.equal(entry("apply-findings").start, Math.max(...ANALYSES.map((id) => entry(id).complete)) + 2);
  // One consolidated analysis that never starts keeps the consolidation incomplete: the work is never delivered.
  assert.deepEqual(
    (await check("c34_consolidation_waits_for_every_mission")).result,
    refused("run", "the work is never delivered (t=152)"),
  );
});

test("TOPO-040 AC3 the order places a mission started by a consolidation after every consolidated mission", {
  skip: icarus,
}, async () => {
  const { result } = await check("c33_analysis_and_consolidation");
  assert.equal(result.accepted, true, result.reason);
  const started = result.structure.find((item) => item.mission === "apply-findings");
  assert.deepEqual(started.after, ANALYSES);
  for (const id of ANALYSES)
    assert.ok(result.structure.find((item) => item.mission === id).complete < started.start, id);
  // The analyses run in parallel: none is ordered after another.
  for (const id of ANALYSES) assert.deepEqual(result.structure.find((item) => item.mission === id).after, []);
});

test("TOPO-050 AC1 the validation input of an interface mission comes from the validation output of the owner element", {
  skip: icarus,
}, async () => {
  assert.equal((await check("c1_interface_validated_by_the_owner")).result.accepted, true);
  assert.deepEqual(
    (await check("c36_validation_not_from_owner")).result,
    refused(
      "wiring",
      "line 10: the validation input of mission_interface b must be driven only by the validation output of an owner; approved is driven by an assignment on line 6",
    ),
  );
  assert.deepEqual(
    (await check("c37_validation_expression")).result,
    refused(
      "wiring",
      "line 9: the validation input of mission_interface b is not a plain net driven by the validation output of an owner",
    ),
  );
});

test("TOPO-050 AC2 the decision input of a mission comes from the decision output of the coordinator element", {
  skip: icarus,
}, async () => {
  for (const name of ["c1_interface_validated_by_the_owner", "c4_nested_delegation", "c33_analysis_and_consolidation"])
    assert.equal((await check(name)).result.accepted, true, name);
  assert.deepEqual(
    (await check("c38_decision_not_from_coordinator")).result,
    refused(
      "wiring",
      "line 7: the decision input of mission a must be driven only by the decision output of a coordinator; arbitration is driven by the arbitration output of owner p",
    ),
  );
});

test("TOPO-050 AC3 each input of a resource is the busy output of a mission, without expression", {
  skip: icarus,
}, async () => {
  assert.equal((await check("c2_same_files_in_sequence")).result.accepted, true);
  assert.deepEqual(
    (await check("c39_resource_input_expression")).result,
    refused(
      "wiring",
      "line 11: the busy_2 input of resource r is not a plain net driven by the busy output of a mission",
    ),
  );
  assert.deepEqual(
    (await check("c40_resource_input_not_busy")).result,
    refused(
      "wiring",
      "line 11: the busy_2 input of resource r must be driven only by the busy output of a mission; k_b is driven by the covers output of mission b",
    ),
  );
});

test("TOPO-050 AC4 a mission with an empty id, assignee or reviewer is refused at wiring with its reason", {
  skip: icarus,
}, async () => {
  assert.deepEqual(
    (await check("c41_empty_id")).result,
    refused("wiring", "ERROR: library.sv:23: mission: the id is empty"),
  );
  assert.deepEqual(
    (await check("c42_empty_assignee")).result,
    refused("wiring", "ERROR: library.sv:24: mission batch-b-card: the assignee is empty"),
  );
  assert.deepEqual(
    (await check("c43_empty_reviewer")).result,
    refused("wiring", "ERROR: library.sv:25: mission batch-b-card: the reviewer is empty"),
  );
  // The missions of a batch are missions too.
  assert.deepEqual(
    (await check("c44_batch_empty_assignee")).result,
    refused("wiring", "ERROR: library.sv:24: mission pdf-export-2: the assignee is empty"),
  );
});

test("TOPO-010 AC2 a mission whose reviewer is also its assignee is refused at wiring with its reason", {
  skip: icarus,
}, async () => {
  const { result } = await check("c5_reviewer_is_assignee");
  assert.deepEqual(
    result,
    refused("wiring", "ERROR: library.sv:22: mission self-review: the reviewer is also the assignee"),
  );
  // A topology cannot print its own protocol lines to declare a mission whose reviewer is its assignee.
  assert.deepEqual(
    (await check("c17_forged_protocol_lines")).result,
    refused("wiring", "line 11: initial is not allowed; a topology file only assembles library elements"),
  );
  // Nor can it hide them behind an escaped identifier: a topology file holds no backslash.
  assert.deepEqual(
    (await check("c23_escaped_forged_mission")).result,
    refused("wiring", "line 12: a backslash is not allowed in a topology file"),
  );
  // Nor behind "/*/", which opens a comment: the check reads it as the tool does and compiles only what it read.
  assert.deepEqual(
    (await check("c27_slash_star_slash_forged_mission")).result,
    refused("wiring", "line 12: initial is not allowed; a topology file only assembles library elements"),
  );
});

test("TOPO-010 AC3 a topology that uses an element absent from the library is refused at wiring with the name of the element", {
  skip: icarus,
}, async () => {
  const { result } = await check("c6_element_absent");
  assert.deepEqual(result, refused("wiring", "line 9: reviewer_pool is not a library element"));
  // An element defined in the topology file itself is not a library element either.
  assert.deepEqual(
    (await check("c18_element_defined_in_topology")).result,
    refused(
      "wiring",
      "line 2: the module definition reviewer_pool is not allowed; a topology file only assembles library elements",
    ),
  );
  assert.deepEqual(
    (await check("c24_escaped_hidden_element")).result,
    refused("wiring", "line 12: a backslash is not allowed in a topology file"),
  );
  assert.deepEqual(
    (await check("c28_slash_star_slash_hidden_element")).result,
    refused(
      "wiring",
      "line 14: the module definition reviewer_pool is not allowed; a topology file only assembles library elements",
    ),
  );
});

test("TOPO-020 AC1 the check refuses a topology whose wiring gives an error or a warning and returns the message of the tool", {
  skip: icarus,
}, async () => {
  // The same wiring run directly with Icarus Verilog gives only a warning and an executable simulation.
  const directory = await mkdtemp(path.join(tmpdir(), "delegation-wiring-"));
  try {
    const sources = [
      path.join(trust, "assets/delegation/library.sv"),
      path.join(trust, "assets/delegation/bench.sv"),
      path.join(trust, CASES, "c7_exception_wired_to_nobody.sv"),
    ];
    const tool = await exec("iverilog", [
      "-g2012",
      "-Wall",
      "-s",
      "bench",
      "-o",
      path.join(directory, "x.vvp"),
      ...sources,
    ]);
    assert.match(
      tool.stderr,
      /c7_exception_wired_to_nobody\.sv:8: warning: Instantiating module mission with dangling input port 3 \(decision\) floating\./u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  const warning = await check("c7_exception_wired_to_nobody");
  assert.deepEqual(
    warning.result,
    refused(
      "wiring",
      "topology.sv:8: warning: Instantiating module mission with dangling input port 3 (decision) floating.",
    ),
  );
  const error = await check("c22_unknown_port");
  assert.deepEqual(error.result, refused("wiring", "topology.sv:8: error: port ``reviewed'' is not a port of a."));
});

test("TOPO-020 AC2 the check runs the topology and refuses work never delivered, two missions at the same time on one resource and a criterion carried by no mission", {
  skip: icarus,
}, async () => {
  assert.deepEqual(
    (await check("c8_work_never_delivered")).result,
    refused("run", "the work is never delivered (t=152)"),
  );
  assert.deepEqual(
    (await check("c2_same_files_in_parallel")).result,
    refused("run", "two missions work at the same time on the resource extensions/corpus/ui (t=2)"),
  );
  assert.deepEqual(
    (await check("c3_criterion_without_mission")).result,
    refused("run", "no mission carries criterion number 3 of [CXP-330.AC1 CXP-330.AC2 CXP-340.AC1] (t=0)"),
  );
  // Nothing drives the delivered output; a delivery tied to 1 while its mission never starts; no mission at all.
  assert.deepEqual((await check("c9_no_delivery")).result, refused("run", "the work is never delivered (t=152)"));
  assert.deepEqual(
    (await check("c16_delivered_without_delivery")).result,
    refused("run", "the topology declares no delivery"),
  );
  assert.deepEqual(
    (await check("c10_delivery_not_driven_by_missions")).result,
    refused("run", "mission thread-states never completes"),
  );
  assert.deepEqual((await check("c11_no_mission")).result, refused("run", "the topology declares no mission"));
  // A topology cannot forge the completion of a mission that never starts and deliver from its own register.
  assert.deepEqual(
    (await check("c19_forged_completion")).result,
    refused("wiring", "line 11: reg is not allowed; a topology file only assembles library elements"),
  );
  assert.deepEqual(
    (await check("c25_escaped_forged_completion")).result,
    refused("wiring", "line 13: a backslash is not allowed in a topology file"),
  );
  assert.deepEqual(
    (await check("c29_slash_star_slash_forged_completion")).result,
    refused("wiring", "line 13: reg is not allowed; a topology file only assembles library elements"),
  );
  // A delayed assignment would shift the run; "#(" is allowed only to set the parameters of an element.
  assert.deepEqual(
    (await check("c26_assign_delay")).result,
    refused("wiring", "line 7: a delay is not allowed; a topology file only assembles library elements"),
  );
  // Nor can an assignment reach inside an element to hide two missions on one resource or force a validation, and
  // an expression names only declared nets.
  assert.deepEqual(
    (await check("c30_hierarchical_busy")).result,
    refused("wiring", "line 18: a drive strength is not allowed"),
  );
  assert.deepEqual(
    (await check("c31_forced_validation")).result,
    refused("wiring", "line 16: a drive strength is not allowed"),
  );
  assert.deepEqual(
    (await check("c32_undeclared_identifier")).result,
    refused("wiring", "line 10: end_x is not declared in the topology"),
  );
  assert.deepEqual(
    (await check("c13_coverage_names_differ")).result,
    refused(
      "run",
      "the coverage names and the missions' criteria differ: carried by no mission [CXP-340.AC1]; not named by the coverage [CXP-330.AC2]",
    ),
  );
  // The same resource used in sequence is accepted, and the structure keeps the order of the two missions.
  const sequence = (await check("c2_same_files_in_sequence")).result;
  assert.equal(sequence.accepted, true);
  assert.deepEqual(
    sequence.structure.map(({ mission, after }) => [mission, after]),
    [
      ["batch-b-card", []],
      ["batch-c-follow-up", ["batch-b-card"]],
    ],
  );
});

test("TOPO-020 AC3 an accepted topology gives its missions, owner decisions and delivery in the form a Plan declaration accepts", {
  skip: icarus,
  timeout: 120000,
}, async () => {
  assert.deepEqual((await check("c1_interface_validated_by_the_owner")).result, ACCEPTED_C1);
  const nested = (await check("c4_nested_delegation")).result;
  assert.equal(nested.accepted, true);
  assert.deepEqual(
    nested.structure.map(({ mission, batch, after }) => [mission, batch, after]),
    [
      ["pdf-export-1", "pdf-export", []],
      ["pdf-export-2", "pdf-export", ["pdf-export-1"]],
    ],
  );
  // With its data file, the topology's missions and delivery go unchanged into a real Plan declaration.
  const data = JSON.parse(await readFile(path.join(trust, CASES, "c15_declared_procedures.missions.json"), "utf8"));
  const { result } = await check("c15_declared_procedures", "c15_declared_procedures.missions.json");
  assert.equal(result.accepted, true, result.reason);
  assert.deepEqual(
    result.missions.map(({ id, definition }) => [id, definition]),
    ["model", "screen"].map((id) => [id, { kind: "published", reference: "topology-work@1.0.0" }]),
  );
  assert.deepEqual(result.delivery, [
    {
      id: "release",
      definition: { kind: "published", reference: "topology-delivery@1.0.0" },
      rootInputs: { project: "trust" },
    },
  ]);
  for (const mission of result.missions) {
    const { mission: name, assignee, reviewer, ...rest } = mission.rootInputs;
    assert.equal(name, mission.id);
    assert.notEqual(assignee, reviewer);
    assert.deepEqual(rest, data[mission.id]);
  }
  assert.deepEqual(result.decisions, [{ mission: "screen", owner: "visual validation" }]);
  assert.deepEqual(result.structure.find((entry) => entry.mission === "screen").after, ["model"]);
  await workspace.rpc("plan.engage", {
    contract: "trust.plan-engagement-request@1",
    procedure: "topology-parent",
    procedureVersion: "1.0.0",
    plan: "declared-topology",
    mode: "dry-run",
    environment: "local",
    rootInputs: {},
  });
  await workspace.rpc("plan.declarations.replace", {
    contract: "trust.plan-declaration-replacement-request@1",
    plan: "declared-topology",
    expectedRevision: (await workspace.rpc("plan.read", { plan: "declared-topology" })).revision,
    declarations: {},
    missionDeclarations: { work: result.missions, delivery: result.delivery },
  });
  const plan = await workspace.rpc("plan.read", { plan: "declared-topology" });
  assert.deepEqual(plan.missionDeclarations.work, result.missions);
  assert.deepEqual(plan.missionDeclarations.delivery, result.delivery);
  const children = plan.invocations.filter((invocation) => invocation.mission).map((i) => [i.mission.id, i.childPlan]);
  assert.deepEqual(children.map(([id]) => id).sort(), ["model", "release", "screen"]);
  for (const [id, child] of children) {
    assert.ok(child, `mission ${id} has a child Plan`);
    const view = await workspace.rpc("plan.read", { plan: child });
    const expected = [...result.missions, ...result.delivery].find((entry) => entry.id === id).rootInputs;
    assert.deepEqual(view.rootInputs, expected);
  }
  // The form is refused before any declaration: repeated id, injected quote (it needs a backslash escape, refused at
  // wiring), mission without data entry.
  assert.deepEqual(
    (await check("c12_duplicate_ids")).result,
    refused("run", "two missions have the same id: thread-states"),
  );
  assert.deepEqual(
    (await check("c14_quote_in_value")).result,
    refused("wiring", "line 7: a backslash is not allowed in a topology file"),
  );
  assert.deepEqual(
    (await check("c15_declared_procedures", "c15_declared_procedures.incomplete.missions.json")).result,
    refused(
      "run",
      "the data file and the topology differ: missions without a data entry [screen]; data entries without a mission []",
    ),
  );
  assert.deepEqual(
    (await check("c15_declared_procedures", "c15_declared_procedures.mismatch.missions.json")).result,
    refused(
      "run",
      "mission screen: its criteria [TOPO-T.AC2] differ from the requirements [TOPO-T.AC3] of its acceptance verification",
    ),
  );
  assert.deepEqual(
    (await check("c15_declared_procedures", "c15_declared_procedures.not-json.missions.json")).result,
    refused("run", "the acceptance verification of mission screen is not JSON"),
  );
  assert.deepEqual(
    (await check("c15_declared_procedures", "c15_declared_procedures.requirements-not-array.missions.json")).result,
    refused("run", "the acceptance verification of mission screen has no requirements array of strings"),
  );
  // A coverage whose count differs from its names, and a delivery input that sets one key twice.
  assert.deepEqual(
    (await check("c20_coverage_count_differs")).result,
    refused("run", "the coverage counts 2 criteria and names 1"),
  );
  assert.deepEqual(
    (await check("c21_delivery_input_repeated")).result,
    refused("run", "the delivery delivery sets its input project twice"),
  );
});

test("TOPO-020 AC4 the same topology gives the same result at each check", { skip: icarus }, async () => {
  for (const name of ["c1_interface_validated_by_the_owner", "c4_nested_delegation", "c7_exception_wired_to_nobody"]) {
    const first = await check(name);
    const second = await check(name);
    assert.equal(second.stdout, first.stdout, name);
    assert.ok(!first.stdout.includes(tmpdir()) && !first.stdout.includes(trust), name);
  }
  // The check compiles only the canonical text it read: every case gives the same result as its canonical text.
  const directory = await mkdtemp(path.join(tmpdir(), "delegation-canonical-"));
  try {
    for (const name of (await readdir(path.join(trust, CASES))).filter((file) => file.endsWith(".sv")).sort()) {
      const original = await exec(process.execPath, [SCRIPT, "check", `${CASES}/${name}`], { cwd: trust });
      const canonical = await exec(process.execPath, [SCRIPT, "canonical", `${CASES}/${name}`], { cwd: trust });
      assert.equal(
        canonical.stdout.split("\n").length,
        (await readFile(path.join(trust, CASES, name), "utf8")).split("\n").length,
      );
      await writeFile(path.join(directory, name), canonical.stdout);
      const rewritten = await exec(process.execPath, [SCRIPT, "check", name], { cwd: directory });
      assert.equal(rewritten.stdout, original.stdout, name);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("TOPO-030 AC1 an Operation checks a topology file of the workspace and produces the verdict, its reason and the missions", {
  skip: icarus,
  timeout: 120000,
}, async () => {
  await workspace.engage("topology-probe", "accepted", {
    topology: `${CASES}/c1_interface_validated_by_the_owner.sv`,
    missions: "none",
  });
  const run = await workspace.run("accepted", "check topology");
  assert.equal(run.verdict, "VALIDATED", run.reason);
  assert.equal(run.lines.length, 8);
  assert.deepEqual(run.lines.slice(0, 4), [
    `${CASES}/c1_interface_validated_by_the_owner.sv`,
    "1",
    "accepted",
    "the topology is wired and delivered",
  ]);
  assert.deepEqual(JSON.parse(run.lines[4]), ACCEPTED_C1.missions);
  assert.deepEqual(JSON.parse(run.lines[5]), ACCEPTED_C1.decisions);
  assert.deepEqual(JSON.parse(run.lines[6]), ACCEPTED_C1.delivery);
  assert.deepEqual(JSON.parse(run.lines[7]), ACCEPTED_C1.structure);
  // With a data file of the workspace, the missions carry its root inputs.
  await workspace.engage("topology-probe", "with-data", {
    topology: `${CASES}/c15_declared_procedures.sv`,
    missions: `${CASES}/c15_declared_procedures.missions.json`,
  });
  const data = await workspace.run("with-data", "check topology");
  assert.equal(data.verdict, "VALIDATED", data.reason);
  assert.deepEqual(
    JSON.parse(data.lines[4]).map((mission) => mission.rootInputs.facet),
    ["code", "interface"],
  );
});

test("TOPO-030 AC2 a Check that uses this Operation gives a negative verdict with the reason of the refusal for a refused topology", {
  skip: icarus,
  timeout: 120000,
}, async () => {
  await workspace.engage("topology-probe", "refused", {
    topology: `${CASES}/c5_reviewer_is_assignee.sv`,
    missions: "none",
  });
  const refusal = await workspace.run("refused", "check topology");
  assert.equal(refusal.verdict, "NOT_VALIDATED");
  assert.equal(refusal.reason, "ERROR: library.sv:22: mission self-review: the reviewer is also the assignee");
  assert.deepEqual(refusal.lines.slice(1, 8), [
    "0",
    "wiring",
    "ERROR: library.sv:22: mission self-review: the reviewer is also the assignee",
    "[]",
    "[]",
    "[]",
    "[]",
  ]);
  await workspace.engage("topology-probe", "never-delivered", {
    topology: `${CASES}/c8_work_never_delivered.sv`,
    missions: "none",
  });
  const run = await workspace.run("never-delivered", "check topology");
  assert.equal(run.verdict, "NOT_VALIDATED");
  assert.equal(run.reason, "the work is never delivered (t=152)");
  await workspace.engage("topology-probe", "nested", {
    topology: `${CASES}/c4_nested_delegation.sv`,
    missions: "none",
  });
  const accepted = await workspace.run("nested", "check topology");
  assert.equal(accepted.verdict, "VALIDATED", accepted.reason);
});
