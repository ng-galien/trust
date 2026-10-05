#!/usr/bin/env node
// Checks a delegation topology written with the Verilog library of assets/delegation: Icarus Verilog wires it with the
// bench, then simulates it. The elements print one field per line; this script parses those lines, validates the
// topology and builds the missions, owner decisions, delivery and mission structure to declare in a Plan.
// Prints one JSON object (or, with --lines, eight fixed lines for an Operation). An optional data file
// (--missions <file>) gives each mission's remaining root inputs. Exits 0 for an accepted or refused topology, 2 for a
// usage error or a missing tool. `canonical <topology.sv>` prints the text the check compiles: the topology with its
// comments blanked.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LIBRARY = fileURLToPath(new URL("../assets/delegation/", import.meta.url));
const TIMEOUT_MS = 30000;
const USAGE = [
  "usage: node scripts/delegation-topology.mjs check <topology.sv> [--missions <missions.json>|none] [--lines]",
  "       node scripts/delegation-topology.mjs canonical <topology.sv>   (prints the text the check compiles)",
].join("\n");
const STRUCTURAL = ["mission", "assignee", "reviewer"];
/** The line protocol of the library: each kind with the keys its elements print. */
const PROTOCOL = {
  MISSION: ["id", "procedure", "assignee", "reviewer", "criteria", "batch"],
  DECISION: ["owner"],
  DELIVERY: ["id", "procedure", "input"],
  COVERAGE: ["count", "names"],
  START: ["time"],
  COMPLETE: ["time"],
  DELIVERED: ["time"],
  EVENT: ["escalation", "arbitration", "validation_request", "validation"],
};
const LINE = /^([A-Z]+) (\S+) (\w+) (.*)$/u;
const ELEMENTS = ["mission", "mission_interface", "batch", "resource", "coverage", "coordinator", "owner", "delivery"];
/** Constructs a topology file never holds: it only assembles library elements with wires and assignments. */
const FORBIDDEN = [
  "initial",
  "always",
  "always_comb",
  "always_ff",
  "always_latch",
  "final",
  "reg",
  "logic",
  "integer",
  "function",
  "task",
  "generate",
  "defparam",
  "force",
  "release",
  "macromodule",
  "primitive",
  "interface",
  "package",
  "program",
  "class",
  "checker",
  "config",
  "bind",
];
/** A value that would break a JSON string or a line: a double quote, a backslash or a control character. */
const unsafe = (value) =>
  [...value].some((character) => {
    const code = character.charCodeAt(0);
    return character === '"' || character === "\\" || code < 32 || code === 127;
  });

const usage = (message) => {
  process.stderr.write(`${message}\n${USAGE}\n`);
  process.exit(2);
};

/** A file named by a relative path below the current directory. */
const local = (file) => {
  const relative = path.relative(process.cwd(), path.resolve(file));
  if (path.isAbsolute(file) || relative.startsWith("..")) usage(`${file} must be a path below the current directory`);
  if (!existsSync(file)) usage(`no file ${file}`);
  return file;
};

const parseArguments = (args) => {
  if (!["check", "canonical"].includes(args[0]) || !args[1]) usage("unknown arguments");
  const options = { command: args[0], topology: local(args[1]), missions: undefined, lines: false };
  if (options.command === "canonical" && args.length > 2) usage("canonical takes only the topology");
  for (let index = 2; index < args.length; index += 1) {
    if (args[index] === "--lines") options.lines = true;
    else if (args[index] === "--missions" && args[index + 1] !== undefined) {
      index += 1;
      if (args[index] !== "none") options.missions = local(args[index]);
    } else usage(`unknown argument ${args[index]}`);
  }
  return options;
};

const run = (directory, tool, args) => {
  const result = spawnSync(tool, args, { cwd: directory, encoding: "utf8", timeout: TIMEOUT_MS });
  if (result.error?.code === "ENOENT") usage(`${tool} is not installed`);
  if (result.error) return { failed: true, output: `${tool} did not finish within ${TIMEOUT_MS / 1000} s` };
  return { failed: result.status !== 0, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
};

/** A refusal of the topology; thrown by the validation steps and caught once. */
class Refusal extends Error {}
const refuse = (message) => {
  throw new Refusal(message);
};
const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const byKey = (key) => (left, right) => compare(left[key], right[key]);
const words = (text) => text.split(" ").filter(Boolean);
const list = (values) => [...values].sort(compare).join(", ");

/** Groups the protocol lines by kind and instance path; refuses an unknown line, a repeated field or an unsafe value. */
const parseLines = (output) => {
  const elements = Object.fromEntries(Object.keys(PROTOCOL).map((kind) => [kind, new Map()]));
  for (const line of output.split("\n")) {
    if (line === "") continue;
    const match = LINE.exec(line);
    if (!match || !PROTOCOL[match[1]]?.includes(match[3]))
      refuse(`the run printed a line outside the protocol: ${line}`);
    const [, kind, place, key, value] = match;
    if (unsafe(value))
      refuse(`the ${key} of ${place} holds a double quote, a backslash or a control character: ${value}`);
    if (kind === "EVENT") continue;
    if (["START", "COMPLETE", "DELIVERED"].includes(kind) && !/^\d+$/u.test(value))
      refuse(`the run printed a line outside the protocol: ${line}`);
    const fields = elements[kind].get(place) ?? {};
    if (key in fields) refuse(`the ${key} of ${place} is printed twice`);
    fields[key] = value;
    elements[kind].set(place, fields);
  }
  for (const kind of ["MISSION", "DELIVERY", "COVERAGE"])
    for (const [place, fields] of elements[kind]) {
      const missing = PROTOCOL[kind].filter((key) => !(key in fields));
      if (missing.length > 0) refuse(`the ${kind.toLowerCase()} ${place} prints no ${missing.join(", ")}`);
    }
  return elements;
};

const unique = (kind, items) => {
  const seen = new Set();
  const repeated = new Set();
  for (const item of items) (seen.has(item.id) ? repeated : seen).add(item.id);
  if (repeated.size > 0) refuse(`two ${kind}s have the same id: ${list(repeated)}`);
};

/** Splits "key=value key=value" into root inputs with sorted keys. */
const pairs = (delivery) =>
  Object.fromEntries(
    words(delivery.input)
      .map((pair) => {
        const at = pair.indexOf("=");
        if (at <= 0) refuse(`the input "${pair}" of the delivery ${delivery.id} is not key=value`);
        return [pair.slice(0, at), pair.slice(at + 1)];
      })
      .map((entry, index, entries) => {
        if (entries.findIndex(([key]) => key === entry[0]) !== index)
          refuse(`the delivery ${delivery.id} sets its input ${entry[0]} twice`);
        return entry;
      })
      .sort(([left], [right]) => compare(left, right)),
  );

/** Reads the data file: one entry per mission, holding its remaining root inputs as strings. */
const readData = (file, missions) => {
  let data;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    refuse(`the data file ${file} is not JSON: ${error.message}`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data))
    refuse(`the data file ${file} is not an object of missions`);
  const ids = new Set(missions.map((mission) => mission.id));
  const absent = [...ids].filter((id) => !(id in data));
  const extra = Object.keys(data).filter((id) => !ids.has(id));
  if (absent.length > 0 || extra.length > 0)
    refuse(
      `the data file and the topology differ: missions without a data entry [${list(absent)}]; data entries without a mission [${list(extra)}]`,
    );
  for (const mission of missions) {
    const entry = data[mission.id];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry))
      refuse(`the data entry of mission ${mission.id} is not an object`);
    for (const [key, value] of Object.entries(entry)) {
      if (STRUCTURAL.includes(key))
        refuse(`the data entry of mission ${mission.id} sets ${key}, which the topology gives`);
      if (typeof value !== "string")
        refuse(`the data entry of mission ${mission.id} gives ${key} as a non-string value`);
    }
    const requirements = contractRequirements(mission.id, entry["acceptance verification"]);
    const criteria = words(mission.criteria);
    if (requirements && (requirements.length !== criteria.length || !requirements.every((id) => criteria.includes(id))))
      refuse(
        `mission ${mission.id}: its criteria [${list(criteria)}] differ from the requirements [${list(requirements)}] of its acceptance verification`,
      );
  }
  return data;
};

/** The requirements of a mission's acceptance verification contract, or undefined when the entry gives none. */
const contractRequirements = (id, contract) => {
  if (contract === undefined) return undefined;
  let value;
  try {
    value = JSON.parse(contract);
  } catch {
    refuse(`the acceptance verification of mission ${id} is not JSON`);
  }
  if (!Array.isArray(value?.requirements) || !value.requirements.every((item) => typeof item === "string"))
    refuse(`the acceptance verification of mission ${id} has no requirements array of strings`);
  return [...new Set(value.requirements)];
};

/** Validates the parsed run and builds the declarations. */
const declarations = (elements, dataFile) => {
  const missions = [...elements.MISSION].map(([place, fields]) => ({ place, ...fields }));
  const deliveries = [...elements.DELIVERY].map(([place, fields]) => ({ place, ...fields }));
  const coverages = [...elements.COVERAGE.values()];
  if (missions.length === 0) refuse("the topology declares no mission");
  unique("mission", missions);
  if (deliveries.length === 0) refuse("the topology declares no delivery");
  unique("delivery", deliveries);
  for (const place of elements.DECISION.keys())
    if (!elements.MISSION.has(place)) refuse(`the decision of ${place} belongs to no mission`);
  if (coverages.length !== 1) refuse(`the topology needs exactly one coverage element and has ${coverages.length}`);
  const named = new Set(words(coverages[0].names));
  if (Number(coverages[0].count) !== words(coverages[0].names).length)
    refuse(`the coverage counts ${coverages[0].count} criteria and names ${words(coverages[0].names).length}`);
  const carried = new Set(missions.flatMap((mission) => words(mission.criteria)));
  const uncarried = [...named].filter((name) => !carried.has(name));
  const unnamed = [...carried].filter((name) => !named.has(name));
  if (uncarried.length > 0 || unnamed.length > 0)
    refuse(
      `the coverage names and the missions' criteria differ: carried by no mission [${list(uncarried)}]; not named by the coverage [${list(unnamed)}]`,
    );
  const time = (kind, place) => (elements[kind].has(place) ? Number(elements[kind].get(place).time) : undefined);
  for (const mission of missions) {
    mission.start = time("START", mission.place);
    mission.complete = time("COMPLETE", mission.place);
    if (mission.complete === undefined) refuse(`mission ${mission.id} never completes`);
    if (mission.start === undefined) refuse(`mission ${mission.id} completes without starting`);
  }
  const last = missions.reduce((latest, mission) => (mission.complete > latest.complete ? mission : latest));
  for (const delivery of deliveries) {
    const delivered = time("DELIVERED", delivery.place);
    if (delivered === undefined) refuse(`the delivery ${delivery.id} is never delivered`);
    if (delivered <= last.complete) refuse(`the delivery ${delivery.id} comes before mission ${last.id} completes`);
  }
  const data = dataFile ? readData(dataFile, missions) : {};
  const sorted = missions.sort(byKey("id"));
  return {
    missions: sorted.map((mission) => ({
      id: mission.id,
      definition: { kind: "published", reference: mission.procedure },
      rootInputs: {
        mission: mission.id,
        assignee: mission.assignee,
        reviewer: mission.reviewer,
        ...Object.fromEntries(Object.entries(data[mission.id] ?? {}).sort(([left], [right]) => compare(left, right))),
      },
    })),
    decisions: [...elements.DECISION]
      .map(([place, fields]) => ({ mission: elements.MISSION.get(place).id, owner: fields.owner }))
      .sort((left, right) => compare(left.mission, right.mission) || compare(left.owner, right.owner)),
    delivery: deliveries.sort(byKey("id")).map((delivery) => ({
      id: delivery.id,
      definition: { kind: "published", reference: delivery.procedure },
      rootInputs: pairs(delivery),
    })),
    structure: sorted.map((mission) => ({
      mission: mission.id,
      criteria: words(mission.criteria),
      batch: mission.batch || null,
      start: mission.start,
      complete: mission.complete,
      after: sorted.filter((other) => other.complete < mission.start).map((other) => other.id),
    })),
  };
};

const oneLine = (text) => text.replace(/\s+/gu, " ").trim();
const refused = (stage, reason) => ({
  accepted: false,
  stage,
  reason: oneLine(reason),
  missions: [],
  decisions: [],
  delivery: [],
  structure: [],
});

/**
 * Reads a topology source the way the Verilog lexer does for comments and string literals. Returns `canonical`, the
 * source with every comment replaced by spaces (line breaks kept, string literals kept): the only text the check
 * compiles. Returns `code`, the canonical text with the content of its string literals also blanked: the text the
 * source check scans. A block comment closes at the first "*\/" after its opening "/*"; a string literal closes on
 * its own line.
 */
const read = (source) => {
  let canonical = "";
  let code = "";
  for (let index = 0; index < source.length; index += 1) {
    const two = source.slice(index, index + 2);
    if (two === "//" || two === "/*") {
      const close = two === "//" ? source.indexOf("\n", index + 2) : source.indexOf("*/", index + 2);
      const stop = close < 0 ? source.length : two === "//" ? close : close + 2;
      const blanks = source.slice(index, stop).replace(/[^\n]/gu, " ");
      canonical += blanks;
      code += blanks;
      index = stop - 1;
    } else if (source[index] === '"') {
      const close = source.indexOf('"', index + 1);
      const line = source.indexOf("\n", index + 1);
      if (close < 0 || (line >= 0 && line < close))
        refuse(`line ${source.slice(0, index).split("\n").length}: a string literal is not closed on its line`);
      canonical += source.slice(index, close + 1);
      code += `"${" ".repeat(close - index - 1)}"`;
      index = close;
    } else {
      canonical += source[index];
      code += source[index];
    }
  }
  return { canonical, code };
};

/**
 * The grammar of a topology, applied to the scanned text. The module header lists `input wire` and `output wire` ports.
 * Its body holds only: a net declaration (`wire` or `uwire` and plain identifiers); an assignment (`assign`, a declared
 * net or output port, `=`, an expression); an instance of a library element with an optional `#(.PARAM(value), ...)`
 * where a value is a string literal or a number, an instance name and `(.port(expression), ...)` (an empty `.port()`
 * is allowed). An expression holds declared nets and ports, `1'b0`, `1'b1`, decimal numbers, parentheses, the
 * operators `& | ^ ~ ! ? :` and the concatenation `{a, b}` that the coverage cases need.
 */
const topologyGrammar = (code, line) => {
  const tokens = [...code.matchAll(/([A-Za-z_]\w*)|(\d+'[A-Za-z]\w*)|(\d+)|("[^"\n]*")|(\S)/gu)].map((match) => ({
    text: match[0],
    index: match.index,
  }));
  tokens.push({ text: "", index: code.length });
  let position = 0;
  const at = () => tokens[position];
  const fail = (token, what) => refuse(`line ${line(token.index)}: ${what}`);
  const unexpected = (token) => fail(token, token.text ? `unexpected "${token.text}"` : "unexpected end of file");
  const identifier = (token) => /^[A-Za-z_]\w*$/u.test(token.text);
  const take = (expected) => {
    const token = at();
    if (expected !== undefined && token.text !== expected) unexpected(token);
    position += 1;
    return token;
  };
  const name = () => {
    const token = at();
    if (!identifier(token)) unexpected(token);
    position += 1;
    return token;
  };
  const inputs = new Set();
  const outputs = new Set();
  const nets = new Set();
  const uses = [];
  /** Reads an expression up to `stop` at depth zero. */
  const expression = (stop) => {
    let depth = 0;
    let braces = 0;
    for (;;) {
      const token = at();
      if (depth === 0 && braces === 0 && token.text === stop) return;
      if (token.text === "") unexpected(token);
      if (identifier(token)) {
        uses.push(token);
        if (tokens[position + 1].text === ".") fail(tokens[position + 1], "a dotted name is not allowed");
      } else if (token.text === "(") depth += 1;
      else if (token.text === ")") {
        if (depth === 0) unexpected(token);
        depth -= 1;
      } else if (token.text === "{") braces += 1;
      else if (token.text === "}") {
        if (braces === 0) unexpected(token);
        braces -= 1;
      } else if (token.text === ",") {
        if (braces === 0) unexpected(token);
      } else if (token.text === ".") fail(token, "a dotted name is not allowed");
      else if (/^\d/u.test(token.text)) {
        if (!/^(\d+|1'b[01])$/u.test(token.text)) fail(token, `the literal ${token.text} is not allowed`);
      } else if (!["&", "|", "^", "~", "!", "?", ":"].includes(token.text))
        fail(token, `the operator "${token.text}" is not allowed`);
      position += 1;
    }
  };
  take("module");
  take("topology");
  take("(");
  do {
    const direction = take();
    if (direction.text !== "input" && direction.text !== "output") unexpected(direction);
    take("wire");
    (direction.text === "input" ? inputs : outputs).add(name().text);
  } while (at().text === "," && take(","));
  take(")");
  take(";");
  while (at().text !== "endmodule") {
    const first = at();
    if (first.text === ";") take(";");
    else if (first.text === "wire" || first.text === "uwire") {
      take();
      if (at().text === "(") fail(at(), "a drive strength is not allowed");
      do nets.add(name().text);
      while (at().text === "," && take(","));
      take(";");
    } else if (first.text === "assign") {
      take();
      if (at().text === "(") fail(at(), "a drive strength is not allowed");
      const target = name();
      if (at().text === ".") fail(at(), "a dotted name is not allowed");
      uses.push({ ...target, target: true });
      take("=");
      expression(";");
      take(";");
    } else if (ELEMENTS.includes(first.text)) {
      take();
      if (at().text === "#") {
        take("#");
        take("(");
        do {
          take(".");
          name();
          take("(");
          const value = take();
          if (!/^("[^"\n]*"|\d+)$/u.test(value.text)) fail(value, "a parameter value is a string literal or a number");
          take(")");
        } while (at().text === "," && take(","));
        take(")");
      }
      name();
      take("(");
      do {
        take(".");
        name();
        take("(");
        if (at().text !== ")") expression(")");
        take(")");
      } while (at().text === "," && take(","));
      take(")");
      take(";");
    } else if (identifier(first)) fail(first, `${first.text} is not a library element`);
    else unexpected(first);
  }
  take("endmodule");
  if (at().text !== "") unexpected(at());
  for (const use of uses) {
    if (use.target && !nets.has(use.text) && !outputs.has(use.text))
      fail(use, `${use.text} is not a net or an output port of the topology`);
    if (!nets.has(use.text) && !inputs.has(use.text) && !outputs.has(use.text))
      fail(use, `${use.text} is not declared in the topology`);
  }
};

/**
 * Refuses a topology file that does more than assemble library elements: only one module, named topology, holding
 * wire and uwire declarations, assignments and instances of the library elements.
 */
const assembleOnly = (source) => {
  const backslash = source.indexOf("\\");
  if (backslash >= 0)
    refuse(`line ${source.slice(0, backslash).split("\n").length}: a backslash is not allowed in a topology file`);
  const { canonical, code } = read(source);
  const line = (index) => code.slice(0, index).split("\n").length;
  const found = [];
  const scan = (pattern, describe) => {
    for (const match of code.matchAll(pattern)) found.push({ index: match.index, text: describe(match) });
  };
  scan(/`\w*/gu, (match) => `the compiler directive ${match[0]}`);
  scan(/\$\w*/gu, (match) => `the system task or function ${match[0]}`);
  // "#(" after a module type sets its parameters (the type is checked below); any other "#" is a delay.
  const NETS = ["wire", "uwire", "assign"];
  scan(/(\w*)\s*#(\s*\()?/gu, (match) =>
    match[2] && /^[A-Za-z_]\w*$/u.test(match[1]) && !NETS.includes(match[1]) ? undefined : "a delay",
  );
  scan(new RegExp(`\\b(${FORBIDDEN.join("|")})\\b`, "gu"), (match) => match[1]);
  scan(/\bmodule\s+(\w+)/gu, (match) => (match[1] === "topology" ? undefined : `the module definition ${match[1]}`));
  const forbidden = found.filter((item) => item.text).sort((left, right) => left.index - right.index)[0];
  if (forbidden)
    refuse(
      `line ${line(forbidden.index)}: ${forbidden.text} is not allowed; a topology file only assembles library elements`,
    );
  const modules = [...code.matchAll(/\bmodule\b/gu)];
  if (modules.length !== 1) refuse("a topology file defines exactly one module, topology");
  topologyGrammar(code, line);
  return canonical;
};

const check = ({ topology, missions }) => {
  let canonical;
  try {
    canonical = assembleOnly(readFileSync(topology, "utf8"));
  } catch (error) {
    if (error instanceof Refusal) return refused("wiring", error.message);
    throw error;
  }
  const directory = mkdtempSync(path.join(tmpdir(), "delegation-topology-"));
  try {
    copyFileSync(path.join(LIBRARY, "library.sv"), path.join(directory, "library.sv"));
    copyFileSync(path.join(LIBRARY, "bench.sv"), path.join(directory, "bench.sv"));
    // The tools compile the canonical text the source check read, never the original file.
    writeFileSync(path.join(directory, "topology.sv"), canonical);
    const args = ["-g2012", "-Wall", "-s", "bench", "-o", "topology.vvp", "library.sv", "bench.sv", "topology.sv"];
    const wiring = run(directory, "iverilog", args);
    const message = wiring.output.split("\n").find((line) => /error|warning/iu.test(line));
    if (wiring.failed || message) return refused("wiring", message ?? (wiring.output || "iverilog failed"));
    const simulation = run(directory, "vvp", ["-n", "topology.vvp"]);
    const refusal = /^REFUSED \S+ reason (.*)$/mu.exec(simulation.output);
    if (refusal) return refused("run", refusal[1]);
    if (simulation.failed) return refused("run", simulation.output.split("\n").filter(Boolean).at(-1) ?? "vvp failed");
    try {
      const result = declarations(parseLines(simulation.output), missions);
      return { accepted: true, stage: "accepted", reason: "the topology is wired and delivered", ...result };
    } catch (error) {
      if (error instanceof Refusal) return refused("run", error.message);
      throw error;
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

const options = parseArguments(process.argv.slice(2));
if (options.command === "canonical") {
  try {
    process.stdout.write(read(readFileSync(options.topology, "utf8")).canonical);
  } catch (error) {
    if (error instanceof Refusal) usage(error.message);
    throw error;
  }
  process.exit(0);
}
const result = check(options);
if (options.lines)
  process.stdout.write(
    `${[
      options.topology,
      result.accepted ? "1" : "0",
      result.stage,
      result.reason,
      JSON.stringify(result.missions),
      JSON.stringify(result.decisions),
      JSON.stringify(result.delivery),
      JSON.stringify(result.structure),
    ].join("\n")}\n`,
  );
else process.stdout.write(`${JSON.stringify(result)}\n`);
