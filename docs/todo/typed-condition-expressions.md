# JavaScript conditions compiled to JSON Logic

## Target

The Procedure DSL no longer defines one relation word for each comparison or calculation.
Predicate tables are replaced by JavaScript expressions carried by Gherkin DocStrings.

The complete path is fixed:

```text
Gherkin DocString `js`
  -> JSEP
  -> TRUST resolution and static typing
  -> JSON Logic
  -> json-logic-engine
  -> Check qualification
```

Procedure authors never write JSON Logic. They write familiar JavaScript expressions. TRUST never
executes those expressions as JavaScript: JSEP only parses them into an AST, which TRUST validates
and compiles.

## Gherkin syntax

A Check keeps its Operation, bindings and success reason. Its predicate table disappears. Each
condition is expressed by one generic Gherkin step followed by a DocString whose required content
type is `js`:

```gherkin
Then Check "aircraft" runs Operation "aviation.aircraft-read"
  on "aircraft" as Input "aircraft"
  and must establish "the aircraft is ready"

And the following condition must hold, otherwise the aircraft is not released:
  """js
  fact.maintenanceStatus === "released"
  """

And the following condition must hold, otherwise the fuel level is insufficient:
  """js
  fact.fuelLevel >= context["minimum fuel"]
  """
```

The fixed step prefix is:

```text
the following condition must hold, otherwise <failure reason>:
```

Everything after `otherwise` and before the final colon is the failure reason. It is plain Gherkin
text, not a quoted DSL value. The following DocString must have the exact content type `js` and must
contain exactly one expression.

Conditions belong to the preceding Check. They are evaluated in source order and form a
conjunction. The first expression that evaluates to `false` supplies its failure reason. A Check is
`VALIDATED` only when every condition evaluates to boolean `true`.

The Check sentence carries no DataTable or DocString. Every Check has at least one condition before
the next Check or the Scenario satisfaction step.

## No Gherkin escaping layer

The JavaScript expression is inside a DocString rather than a Gherkin table. Quotes, pipes,
backslashes and line breaks therefore keep their ordinary JavaScript meaning:

```gherkin
And the following condition must hold, otherwise no release source is ready:
  """js
  fact.primaryStatus === "ready" || fact.secondaryStatus === "ready"
  """
```

```gherkin
And the following condition must hold, otherwise the code is not accepted:
  """js
  fact.code === "A|B"
  """
```

```gherkin
And the following condition must hold, otherwise the path is not the expected path:
  """js
  fact.path === "C:\\temp"
  """
```

Gherkin only dedents the DocString. It does not reinterpret the expression as a table cell. JSEP
receives the resulting text directly. The only escaping visible to an author is normal JavaScript
string escaping.

Expressions may span several lines:

```gherkin
And the following condition must hold, otherwise the departure is not authorized:
  """js
  (
    fact.maintenanceStatus === "released" ||
    fact.overrideStatus === "approved"
  ) &&
  fact.fuelLevel >= context["minimum fuel"] &&
  context["allowed airports"].includes(fact.airport)
  """
```

## Injected values

The expression sees only three read-only roots:

| Root | Meaning |
| --- | --- |
| `fact` | The complete Produced values accepted for the current Check |
| `context` | Plan roles visible in the current Check scope |
| `checks` | Produced values from explicitly referenced prerequisite Checks |

Examples:

```js
fact.status === "ready"
fact.total / fact.count <= 10
context["allowed statuses"].includes(fact.status)
fact.revision === checks["build"].builtRevision
fact.signedAt > checks["open"].openedAt
```

Names are resolved at publication. An unknown root, role, Check or field is a compilation error.
References to other Checks are also compiled as dependency metadata; the evaluator does not perform
dynamic lookups.

No filesystem, process, environment variable, network, clock, random source, module, prototype or
mutation API is exposed.

## Closed JavaScript expression surface

The source looks like JavaScript but remains a closed expression language. JSEP parses it; TRUST
accepts only the following families.

### Values and access

- boolean, finite number and string literals;
- homogeneous array literals;
- parentheses;
- property access on the four injected roots;
- bracket access for names containing spaces or punctuation;
- callback parameters declared by an admitted collection method.

### Operators

- arithmetic: `+`, `-`, `*`, `/`, `%` and unary `-`;
- strict equality: `===` and `!==`;
- ordering: `<`, `<=`, `>`, `>=`;
- boolean logic: `&&`, `||`, `!`;
- conditional expression: `condition ? whenTrue : whenFalse`.

Loose equality, implicit coercion and assignment are not accepted.

### Numbers

```js
Math.min(a, b)
Math.max(a, b)
Math.abs(value)
Math.floor(value)
Math.ceil(value)
Math.round(value)
Math.sqrt(value)
Math.pow(base, exponent)
```

Only finite numbers enter and leave a condition. A non-finite or out-of-domain intermediate result
makes the condition false and returns that condition's failure reason.

### Collections

```js
values.length
values.includes(expected)
values.some(item => item.amount > 100)
values.every(item => item.status === "ready")
values.filter(item => item.enabled)
values.map(item => item.amount)
values.reduce((total, item) => total + item.amount, 0)
```

`reduce` always requires an explicit initial value. Empty collections follow JavaScript boolean
semantics: `some` is false and `every` is true. Collection callbacks are expressions, not executable
JavaScript functions; blocks, statements, async callbacks and mutation are rejected.

### Strings

```js
text.length
text.includes(fragment)
text.startsWith(prefix)
text.endsWith(suffix)
text.substring(start, end)
text.toLowerCase()
text.toUpperCase()
text.trim()
```

### Instants

Values declared as `instant` are normalized by TRUST before evaluation and use the ordinary ordered
operators:

```js
fact.signedAt < context["closure time"]
fact.closedAt >= checks["open"].openedAt
```

The source language contains no date-specific Gherkin relation.

### Rejected JavaScript

Statements, assignments, updates, loops, declarations, object construction, `new`, arbitrary
function calls, template evaluation, regular expressions, optional host methods, dynamic property
names and imports are rejected. Parser support for a JavaScript construct never makes that construct
part of the Procedure language.

## Static typing

TRUST types the JSEP AST before generating JSON Logic. Types come from Product Action Contracts,
Procedure roles and referenced Check outputs. The effective `one`, `each` and `all` scope determines
whether a reference is a scalar or a collection.

The type checker verifies operands, method receivers, callback parameters, callback results and the
final expression. Every condition must produce `boolean`. Every Produced observation required by the
Operation remains required before qualification; expressions do not provide a missing-value escape
hatch.

## JSON Logic compilation

The JavaScript surface is syntactic sugar for a closed JSON Logic profile:

| JavaScript source | JSON Logic target |
| --- | --- |
| `a + b`, `a - b`, `a * b`, `a / b`, `a % b` | `+`, `-`, `*`, `/`, `%` |
| `a === b`, `a !== b` | `===`, `!==` |
| `a < b`, `a <= b`, `a > b`, `a >= b` | `<`, `<=`, `>`, `>=` |
| `a && b`, `a || b`, `!a` | `and`, `or`, `!` |
| `condition ? a : b` | `if` |
| `values.includes(value)` | `in` |
| `some`, `every`, `filter`, `map`, `reduce` | `some`, `all`, `filter`, `map`, `reduce` |
| `Math.min`, `Math.max` | `min`, `max` |
| `Math.abs`, `Math.floor`, `Math.ceil`, `Math.round`, `Math.sqrt`, `Math.pow` | `trust.abs`, `trust.floor`, `trust.ceil`, `trust.round`, `trust.sqrt`, `trust.pow` |
| array or string `.length` | `trust.length` |
| string `.includes`, `.substring` | `in`, `substr` |
| string `.startsWith`, `.endsWith` | `trust.starts-with`, `trust.ends-with` |
| string `.toLowerCase`, `.toUpperCase`, `.trim` | `trust.lower`, `trust.upper`, `trust.trim` |

The emitted rule is canonical JSON. The rule, expression profile, resolved references and types enter
the Procedure definition digest. Formatting the DocString does not change that digest.

Raw JSON Logic is never accepted as Procedure source.

## Compiled condition

The compiled Check replaces predicates with conditions:

```ts
interface CompiledProcedureCondition {
  readonly source: string;
  readonly logic: JsonLogicRule;
  readonly failureReason: string;
  readonly references: readonly CompiledExpressionReference[];
  readonly location: SourceLocation;
}
```

The compiled Procedure identifies the expression profile:

```ts
interface CompiledProcedure {
  readonly expressionProfile: "trust.json-logic@1";
  // ...
}
```

`source` is retained for diagnostics and display. Runtime behavior comes from the canonical compiled
rule.

## Runtime qualification

For a complete accepted Fact batch, TRUST builds the injected read-only values from the condition's
compiled references and evaluates its JSON Logic with `json-logic-engine` in synchronous mode.

Conditions are evaluated in order. The first false condition produces `NOT_VALIDATED` with its
failure reason. If every condition is true, the Check is `VALIDATED` with its success reason. The
runner continues to execute the Operation and never qualifies the Check.

Only operators from `trust.json-logic@1` are registered. Asynchronous operations, dynamic extension,
host method access and rule-supplied functions are unavailable.

## Relation to JSONata

The authoring model resembles JSONata: an expression is embedded beside Gherkin and evaluated over
an explicitly injected JSON-shaped context. Authors manipulate values directly instead of selecting
one named DSL relation after another.

The difference is the expression language and execution path. Conditions use familiar JavaScript
expression syntax parsed by JSEP, are statically typed by TRUST, compile to JSON Logic and run through
`json-logic-engine`. They are not JSONata expressions and create no JSONata compatibility contract.

## Migration from predicate tables

The current relations translate directly:

| Current predicate | JavaScript condition |
| --- | --- |
| `status / equals / value "ready"` | `fact.status === "ready"` |
| `count / at least / number 2` | `fact.count >= 2` |
| `items / has at least / number 2` | `fact.items.length >= 2` |
| `status / is in / context "allowed status"` | `context["allowed status"].includes(fact.status)` |
| `signedAt / before / context "closure time"` | `fact.signedAt < context["closure time"]` |
| `signedAt / after / field "openedAt" from Check "open"` | `fact.signedAt > checks["open"].openedAt` |
| `timestamp / equals / valid rfc3339` | removed: the `instant` schema validates it before qualification |

This replaces the table rather than supporting both forms. There is no compatibility adapter and no
second predicate language.

## Change surface — high-level map

| Area | Change |
| --- | --- |
| Procedure authoring | Predicate tables disappear; ordered `js` DocString condition steps replace them |
| Gherkin compilation | Condition steps and DocStrings are collected with their physical source locations |
| Procedure compilation | JSEP parsing, closed-AST validation, type checking, dependency extraction and JSON Logic emission replace relation parsing |
| Compiled Procedure contract | `predicates` become canonical compiled `conditions` and the JSON Logic profile becomes explicit |
| Plan construction | Context and prerequisite Check dependencies come from compiled expression references |
| Qualification runtime | Relation-specific matching becomes evaluation of the compiled JSON Logic conditions |
| Persistence and digests | Canonical rules, resolved references and the profile participate in stored definitions and digests |
| Interface | Procedure and Plan views show the JavaScript condition and its failure reason rather than field/relation/expectation columns |
| Authoritative Procedures | Existing predicate tables are migrated to the single DocString form |
| Documentation and acceptance | Examples, diagnostics, formatting, compilation and end-to-end verdict evidence use the new form |

The external runner boundary, Fact completeness rule, immutable Snapshots, qualification cascade,
Check URI and `VALIDATED` / `NOT_VALIDATED` contract do not change.
