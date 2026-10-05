# Delegation topology library

A delegation topology describes the missions of a piece of work, how they are wired and how the work is delivered. It is
written in SystemVerilog as a module named `topology` with the elements of [library.sv](library.sv). [bench.sv](bench.sv)
starts it and refuses a work that is never delivered. The topology gives the structure; the content of each mission (its
instructions, contract and other root inputs) comes from an optional data file.

| Element | Stands for |
| --- | --- |
| `mission` | A code mission (`PROCEDURE`, default `delegation-code@2.0.0`) with its assignee, reviewer and criteria; it may stop on an out-of-scope question (`OUT_OF_SCOPE`) and wait for the arbitration. The reviewer cannot be the assignee. |
| `mission_interface` | An interface mission (default `delegation-interface@3.0.0`): it completes only after the owner's visual validation, which it declares as an owner decision. |
| `batch` | One delegated unit holding two missions run one after the other (nested delegation); both missions name their batch. |
| `resource` | Something two missions never hold at the same time, such as the same files. |
| `coverage` | The criteria of the thread (`NAMES`): each one is carried by a mission, and every mission criterion is named. |
| `coordinator` | Escalates a mission's question to the owner and passes the arbitration back. |
| `owner` | The product owner: answers an escalation with an arbitration and a validation request with a validation. |
| `delivery` | The delivery (`ID`, `PROCEDURE`) declared once every mission is complete; `INPUT` holds its root inputs as space-separated `key=value` pairs. |

A text parameter holds no double quote, backslash or control character.

## What a topology file may contain

A topology file only assembles library elements. It holds exactly one module, `topology`, whose header lists the bench's
ports as `input wire <name>` and `output wire <name>`. Its body holds only three statements:

- a net declaration: `wire` or `uwire`, then a comma-separated list of plain identifiers (no range, initial value or
  strength);
- an assignment: `assign`, a net declared in the topology or an output port, `=`, an expression;
- an instance: a library element, an optional `#(.PARAM(value), ...)` where a value is a string literal or a number, an
  instance name, then `(.port(expression), ...)`; an empty `.port()` is allowed and Icarus Verilog reports the dangling
  input as a warning.

An expression holds only nets and ports of the topology, `1'b0`, `1'b1`, decimal numbers, parentheses, the operators
`& | ^ ~ ! ? :` and the concatenation `{a, b}`, which the coverage cases need to wire several criteria.

Before Icarus Verilog runs, the check refuses at stage `wiring`, naming the construct and its line, everything else: a
dotted name outside `.port(` and `.PARAM(`, a drive strength, an attribute, any other operator, an identifier that is not
declared, another module definition, an instance of any other module, a system task or function (`$...`), `initial`,
`always`, `reg`, `logic`, `integer`, `function`, `task`, `generate`, `defparam`, `force`, `release` and the other
definition keywords, a delay (any `#` except the `#(` that sets the parameters of an element), a compiler directive, any
backslash in code, comments or strings (so there is no escaped identifier and no string escape), and a string literal
not closed on its line. Comments are read as the Verilog lexer reads them: `//` to the end of the line, `/*` to the
first `*/` after it.

The check then compiles the canonical text it has read, never the original file: the topology with every comment
replaced by spaces (line breaks and string literals kept), so whatever the source check did not see is never compiled
and line numbers stay those of the original. `node scripts/delegation-topology.mjs canonical <topology.sv>` prints that
text. So the protocol lines come only from the library.

## Check a topology

```sh
node scripts/delegation-topology.mjs check assets/delegation/cases/c1_interface_validated_by_the_owner.sv
node scripts/delegation-topology.mjs check assets/delegation/cases/c15_declared_procedures.sv \
  --missions assets/delegation/cases/c15_declared_procedures.missions.json
```

The check runs `iverilog -g2012 -Wall -s bench` on the library, the bench and the topology (wiring), then `vvp -n` (run),
in a temporary directory. Any error or warning at wiring, or a `REFUSED` line during the run, refuses the topology with
that message as the reason. The elements print one field per line, `<KIND> <instance path> <key> <value>`; the script
parses these lines and refuses an unknown line, a repeated field, an unsafe value, a repeated mission or delivery id, a
topology without mission, delivery or exactly one coverage element, coverage names that differ from the missions'
criteria or whose count differs from its names, a mission that never completes or completes without starting, a delivery that comes before the last mission completes and a delivery input that sets a key twice.

The data file maps each mission id to its remaining root inputs (strings). Every mission needs an entry and every entry a
mission; an entry's `acceptance verification`, when present, must be JSON with a `requirements` array of strings equal to the mission's criteria.

The check prints one JSON object: `accepted`, `stage` (`wiring`, `run` or `accepted`), `reason`, and for an accepted
topology `missions` and `delivery` (entries of a Plan mission declaration), `decisions` (owner decisions) and `structure`
(each mission's criteria, batch, start and completion times and the missions complete before it starts). `--lines`
prints the same result on eight fixed lines for the Operation `delegation.topology-check`. Icarus Verilog (`iverilog`,
`vvp`) must be installed.

[cases/](cases): `c1`, `c2_same_files_in_sequence`, `c4` and `c15` (with its data file) are accepted; the others are refused.
