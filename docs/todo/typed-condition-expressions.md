# JavaScript qualifications compiled to JSON Logic

## Target

The Procedure DSL no longer defines one relation word for each comparison or calculation.
Predicate tables are replaced by one JavaScript qualification expression attached directly to each
Check as a Gherkin DocString.

The authoring path is fixed:

```text
Check with a `js` DocString
  -> JSEP
  -> TRUST resolution and static typing
  -> JSON Logic
  -> json-logic-engine
  -> Check qualification
```

Procedure authors never write JSON Logic. They write familiar JavaScript expressions. TRUST never
executes the source as JavaScript: JSEP parses it into an AST, which TRUST validates and compiles.

## Gherkin syntax

A Check keeps its Operation, bindings and success reason. Its predicate table is replaced by a
DocString whose required content type is `js`. The DocString is the argument of the Check step; no
additional condition, `otherwise` or reporting step is added to Gherkin.

```gherkin
Then Check "aircraft" runs Operation "aviation.aircraft-read"
  on "aircraft" as Input "aircraft"
  using "minimum fuel" as Input "minimumFuel"
  and must establish "the aircraft is ready"
  """js
  fact.fuelLevel >= context["minimum fuel"] ||
  fail(`Fuel level ${fact.fuelLevel} is below the required minimum ${context["minimum fuel"]}`)
  """
```

The qualification form is:

```js
booleanExpression || fail(stringExpression)
```

The left-hand expression states what must be true. The `fail(...)` expression carries the reason to
return when it is false. The reason is an expression rather than static Gherkin text, so it may use
the same typed values as the qualification and include the values that explain the failure.

Every Check has exactly one `js` DocString. The DocString replaces the predicate DataTable rather
than supplementing it.

## Several failure reasons

One compound qualification may have one shared failure reason:

```gherkin
Then Check "deployment" runs Operation "kubernetes.deployment-read"
  on "deployment" as Input "deployment"
  using "minimum replicas" as Input "minimumReplicas"
  and must establish "the deployment is stable"
  """js
  (
    fact.status === "stable" &&
    fact.availableReplicas >= context["minimum replicas"]
  ) ||
  fail(`Deployment is ${fact.status} with ${fact.availableReplicas} available replicas; ${context["minimum replicas"]} are required`)
  """
```

Independent qualifications may keep independent reasons by joining guards with `&&`:

```gherkin
Then Check "batch" runs Operation "food.batch-read"
  on "batch" as Input "batch"
  using "minimum temperature" as Input "minimumTemperature"
  using "maximum temperature" as Input "maximumTemperature"
  and must establish "the batch can be released"
  """js
  (
    (
      fact.temperature >= context["minimum temperature"] &&
      fact.temperature <= context["maximum temperature"]
    ) ||
    fail(`Measured temperature ${fact.temperature} is outside the permitted range ${context["minimum temperature"]} to ${context["maximum temperature"]}`)
  ) && (
    fact.laboratoryStatus === "accepted" ||
    fail(`Laboratory status is ${fact.laboratoryStatus}`)
  )
  """
```

Guards are considered in source order. The first guard whose boolean expression is false supplies
its failure reason. The Check is valid only when every guard succeeds.

An ordinary boolean alternative remains inside the guard's left-hand expression:

```gherkin
Then Check "release source" runs Operation "release.source-read"
  on "release" as Input "release"
  and must establish "a release source is ready"
  """js
  (
    fact.primaryStatus === "ready" ||
    fact.secondaryStatus === "ready"
  ) ||
  fail(`Neither release source is ready: primary is ${fact.primaryStatus}, secondary is ${fact.secondaryStatus}`)
  """
```

## No Gherkin escaping layer

The expression is inside a DocString rather than a Gherkin table. Quotes, pipes, backslashes and
line breaks therefore keep their ordinary JavaScript meaning:

```gherkin
Then Check "code" runs Operation "source.code-read"
  on "source" as Input "source"
  and must establish "the code is accepted"
  """js
  fact.code === "A|B" ||
  fail(`Code ${fact.code} is not accepted`)
  """
```

```gherkin
Then Check "path" runs Operation "filesystem.path-read"
  on "path" as Input "path"
  and must establish "the expected path is selected"
  """js
  fact.path === "C:\\temp" ||
  fail(`Path ${fact.path} is not C:\\temp`)
  """
```

Gherkin only dedents the DocString. It does not reinterpret the source as a table cell. JSEP receives
the resulting text directly. The only escaping visible to an author is ordinary JavaScript string
or template-literal escaping.

## Injected values

The expression sees only three read-only roots:

| Root | Meaning |
| --- | --- |
| `fact` | The complete Produced values accepted for the current Check |
| `context` | Plan roles visible in the current Check scope, keyed by their role names |
| `checks` | Produced values from explicitly referenced prerequisite Checks |

Examples of admitted boolean and reason expressions include:

```js
fact.status === "ready"
fact.total / fact.count <= 10
context.allowedStatuses.includes(fact.status)
fact.revision === checks.build.builtRevision
fact.signedAt > checks.open.openedAt
`Observed status is ${fact.status}`
```

Role names that are valid JavaScript identifiers use property access, as in
`context.minimumFuel`. Natural-language role names use bracket access, as in
`context["minimum fuel"]`. Operation Input names remain binding names and do not rename the Plan roles
visible to the qualification.

Names are resolved at publication. An unknown root, role, Check or field is a compilation error.
References to other Checks are also compiled as dependency metadata; the evaluator does not perform
dynamic lookups.

No filesystem, process, environment variable, network, clock, random source, module, prototype or
mutation API is exposed.

## Closed JavaScript expression surface

The source looks like JavaScript but remains a closed expression language. JSEP parses it; TRUST
accepts only the following families.

The parser profile enables JSEP's template-literal and arrow-expression plugins for the admitted
forms below. Assignment, object, spread, regular-expression and other syntax plugins are not part of
the profile.

### Qualification guards

- `fail(reason)` is the only qualification special form;
- `reason` must be a statically typed string expression;
- `fail` is admitted only as the right-hand side of a qualification guard's `||`;
- one guard or a parenthesized `&&` chain of guards forms the complete Check qualification;
- arbitrary calls to `fail`, aliases of `fail`, and values returned by `fail` are rejected.

`fail` is authoring syntax, not a host JavaScript function and not a procedure-specific Gherkin
operator.

### Values and access

- boolean, finite number and string literals;
- string template literals whose substitutions are admitted typed expressions;
- homogeneous array literals;
- parentheses;
- property access on the injected roots;
- bracket access where the referenced contract name requires it;
- callback parameters declared by an admitted collection method.

Object literals, tagged templates and arbitrary string-template functions are not admitted.

### Operators

- arithmetic: `+`, `-`, `*`, `/`, `%` and unary `-`;
- strict equality: `===` and `!==`;
- ordering: `<`, `<=`, `>`, `>=`;
- boolean logic: `&&`, `||`, `!`;
- conditional expression: `condition ? whenTrue : whenFalse` inside a boolean or reason expression.

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

Only finite numbers enter and leave expressions. A non-finite or out-of-domain intermediate result
makes its guard fail and uses that guard's reason expression.

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

Values declared as `instant` are normalized before evaluation and use the ordinary ordered
operators:

```js
fact.signedAt < context.closureTime
fact.closedAt >= checks.open.openedAt
```

The source language contains no date-specific Gherkin relation.

### Rejected JavaScript

Statements, assignments, updates, loops, declarations, object construction, `new`, arbitrary
function calls, tagged templates, regular expressions, optional host methods, dynamic property names
and imports are rejected. Parser support for a JavaScript construct never makes that construct part
of the Procedure language.

## Static typing

TRUST types the JSEP AST before generating JSON Logic. Types come from Product Action Contracts,
Procedure roles and referenced Check outputs. The effective `one`, `each` and `all` scope determines
whether a reference is a scalar or a collection.

For every guard, the type checker requires a boolean left-hand expression and a string argument to
`fail`. A complete qualification must be one guard or an ordered conjunction of guards. A false path
without a failure reason is not accepted.

The type checker also verifies operands, method receivers, callback parameters, callback results and
template substitutions. Every Produced observation required by the Operation remains required
before qualification; expressions do not provide a missing-value escape hatch.

## JSON Logic compilation

The JavaScript surface is syntactic sugar for a closed JSON Logic profile:

| JavaScript source | JSON Logic target |
| --- | --- |
| `a + b`, `a - b`, `a * b`, `a / b`, `a % b` | `+`, `-`, `*`, `/`, `%` |
| `a === b`, `a !== b` | `===`, `!==` |
| `a < b`, `a <= b`, `a > b`, `a >= b` | `<`, `<=`, `>`, `>=` |
| `a && b`, `a || b`, `!a` inside a guard | `and`, `or`, `!` |
| `condition ? a : b` | `if` |
| `` `value ${a}` `` | `cat` |
| `values.includes(value)` | `in` |
| `some`, `every`, `filter`, `map`, `reduce` | `some`, `all`, `filter`, `map`, `reduce` |
| `Math.min`, `Math.max` | `min`, `max` |
| `Math.abs`, `Math.floor`, `Math.ceil`, `Math.round`, `Math.sqrt`, `Math.pow` | `trust.abs`, `trust.floor`, `trust.ceil`, `trust.round`, `trust.sqrt`, `trust.pow` |
| array or string `.length` | `trust.length` |
| string `.includes`, `.substring` | `in`, `trust.substring` |
| string `.startsWith`, `.endsWith` | `trust.starts-with`, `trust.ends-with` |
| string `.toLowerCase`, `.toUpperCase`, `.trim` | `trust.lower`, `trust.upper`, `trust.trim` |

Each `booleanExpression || fail(stringExpression)` guard emits two canonical JSON Logic rules: one
for the boolean condition and one for the failure reason. The `fail` authoring form is not emitted as
a general JSON Logic operator. A conjunction of guards preserves their source order.

The canonical rules, resolved references and types enter the Procedure
definition digest. Formatting the DocString does not change that digest. Raw JSON Logic is never
accepted as Procedure source.

## Compiled qualification

The compiled Check replaces predicates with one qualification containing ordered guards:

```ts
interface CompiledProcedureQualification {
  readonly source: string;
  readonly guards: readonly CompiledProcedureGuard[];
  readonly location: SourceLocation;
}

interface CompiledProcedureGuard {
  readonly conditionLogic: JsonLogicRule;
  readonly failureReasonLogic: JsonLogicRule;
  readonly references: readonly CompiledExpressionReference[];
}
```

The source is retained for diagnostics and display. Runtime behavior comes from the canonical
compiled rules.

## Runtime qualification

For a complete accepted Fact batch, TRUST builds the injected read-only values from the compiled
references and evaluates each guard's condition with `json-logic-engine` in synchronous mode.

Guards are evaluated in source order. The first false condition evaluates its failure-reason rule
and produces `NOT_VALIDATED` with that resulting string. If every guard is true, the Check is
`VALIDATED` with its `must establish` success reason. The runner continues to execute the Operation
and never qualifies the Check.

Only operators from the closed qualification surface are registered. Asynchronous operations, dynamic extension,
host method access and rule-supplied functions are unavailable.

## Relation to JSONata

The authoring model resembles JSONata: an expression is embedded beside Gherkin and evaluated over
an explicitly injected JSON-shaped context. Authors manipulate values directly instead of selecting
one named DSL relation after another.

The difference is the expression language and execution path. Qualifications use familiar
JavaScript expression syntax parsed by JSEP, are statically typed, compile to JSON Logic and run
through `json-logic-engine`. They are not JSONata expressions.

## Migration from predicate tables

Current predicates move into guards inside the Check's single DocString:

| Current predicate | JavaScript guard |
| --- | --- |
| `status / equals / value "ready"` | `fact.status === "ready" \|\| fail("status is " + fact.status)` |
| `count / at least / number 2` | `fact.count >= 2 \|\| fail("count is " + fact.count + "; at least 2 are required")` |
| `items / has at least / number 2` | `fact.items.length >= 2 \|\| fail("only " + fact.items.length + " items are present")` |
| `status / is in / context "allowed status"` | `context["allowed status"].includes(fact.status) \|\| fail("status " + fact.status + " is not allowed")` |
| `signedAt / before / context "closure time"` | `fact.signedAt < context["closure time"] \|\| fail("signature time " + fact.signedAt + " is not before " + context["closure time"])` |
| `signedAt / after / field "openedAt" from Check "open"` | `fact.signedAt > checks.open.openedAt \|\| fail("signature time " + fact.signedAt + " is not after " + checks.open.openedAt)` |
| `timestamp / equals / valid rfc3339` | removed: the `instant` schema validates it before qualification |

The table disappears. The Check qualification is the `js` DocString.

## Change surface — high-level map

| Area | Change |
| --- | --- |
| Procedure authoring | Predicate tables disappear; one `js` qualification DocString becomes the Check step argument |
| Gherkin compilation | The Check's DocString and physical source location are collected with the Check |
| Procedure compilation | JSEP parsing, guard extraction, closed-AST validation, type checking, dependency extraction and JSON Logic emission replace relation parsing |
| Compiled Procedure | `predicates` become one canonical compiled qualification with ordered condition and reason rules |
| Plan construction | Context and prerequisite Check dependencies come from compiled expression references |
| Qualification runtime | Relation-specific matching becomes ordered evaluation of compiled guards and their failure reasons |
| Persistence and digests | Canonical rules and resolved references participate in stored definitions and digests |
| Interface | Procedure and Plan views show the JavaScript qualification and the evaluated reason rather than field/relation/expectation columns |
| Authoritative Procedures | Existing predicate tables are migrated to the single DocString form |
| Documentation and acceptance | Examples, diagnostics, formatting, compilation and end-to-end verdict evidence use the new form |

The external runner boundary, Fact completeness rule, immutable Snapshots, qualification cascade,
Check URI and `VALIDATED` / `NOT_VALIDATED` contract do not change.
