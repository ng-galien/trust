# I want another system to supply inputs and receive outputs

Use an Operation to read or change external state, and a Procedure to qualify the
observed response. The external system owns its documents; TRUST owns Check
qualification and history. Adapt the example contract below to the real API.

## 1. Write down the small external contract

Example service (illustrative, not a built-in TRUST endpoint):

| Request | Response / behavior |
| --- | --- |
| `GET /contexts/EXPORT-42` | The nested document below |
| `POST /reviews` with `{"record":"EXPORT-42","revision":"r7"}` | Records that this version was read; returns the persisted receipt below |
| Repeat the same POST | Returns the same receipt for this record/revision pair |

```json
{
  "document": {
    "id": "EXPORT-42",
    "revision": "r7",
    "content": { "description": "Export consumed by an automated client" }
  }
}
```

```json
{
  "receipt": {
    "record": "EXPORT-42",
    "revision": "r7",
    "state": "recorded"
  }
}
```

The receipt proves persistence under this service's contract, not human approval.
The repeat behavior is an assumption of this example API; verify the real API's
retry semantics before using a mutating Operation.

## 2. Read nested data into typed observations

```gherkin operation
@trust-dsl:1 @operation:method.context-read @version:1.0.0
Feature: Read a versioned context document
  Background: Operation interface
    Given Environment
      | name | type |
      | contextsUrl | url |
    And Input
      | input | type | cardinality |
      | record | reference | one |
    And Produced fields
      | field | type | cardinality | domain |
      | record | reference | one | any |
      | revision | reference | one | any |
      | description | string | one | any |
  Scenario: Run
    When HTTP "document" sends "GET" to Environment "contextsUrl"
      appending Input "record" and reads JSON
    Then Produce with JSONata
      """
      {
        "record": steps.document.body.document.id,
        "revision": steps.document.body.document.revision,
        "description": steps.document.body.document.content.description
      }
      """
```

Observe identity and revision from the **response**. Echoing `input.record` would
not detect a service returning the wrong document. The nested document remains
external; Produced exposes exactly the typed observations needed by the method.

## 3. Write the selected version and observe the stored receipt

```gherkin operation
@trust-dsl:1 @operation:method.review-write @version:1.0.0
Feature: Record that one context version was read
  Background: Operation interface
    Given Environment
      | name | type |
      | reviewsUrl | url |
    And Input
      | input | type | cardinality |
      | record | reference | one |
      | revision | reference | one |
    And Produced fields
      | field | type | cardinality | domain |
      | record | reference | one | any |
      | revision | reference | one | any |
      | state | string | one | enum "recorded", "rejected" |
  Scenario: Run
    When HTTP "receipt" sends "POST" to Environment "reviewsUrl"
      with Input as JSON body and reads JSON
    Then Produce with JSONata
      """
      {
        "record": steps.receipt.body.receipt.record,
        "revision": steps.receipt.body.receipt.revision,
        "state": steps.receipt.body.receipt.state
      }
      """
```

For a differently shaped request, use `with JSONata body` and a DocString such as
`{ "document": { "id": input.record, "revision": input.revision } }`.
If the API returns only an acknowledgment, add a read-back step and project its
observed state; do not manufacture a successful receipt from the submitted Input.

## 4. Connect read, context and write in a complete Procedure

Requires both Operations above in the compilation catalog. For an inline mission,
supply both as `operationSources` with this source as `procedureSource` instead.

```gherkin procedure
@trust-dsl:1 @procedure:record-context-review @version:1.0.0
Feature: Read a context version and record its review receipt
  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all | Read assigned context documents and record their read receipts. | Edit documents or claim product approval. |
    And many reference "context record"
    And one reference "observed revision" for each "context record"
    And one string "description" for each "context record"
  @scenario:read
  Scenario: Read the assigned context versions
    Then Check "read context" runs Operation "method.context-read@1.0.0"
      on each "context record" as Input "record"
      and materializes "observed revision" from field "revision"
      and materializes "description" from field "description"
      and must establish "the correct context has a recorded description"
      """js
      (fact.record === context["context record"] && fact.description !== "") ||
      fail("the response belongs to another context or has no description")
      """
  @scenario:record
  Scenario: Persist a receipt for each observed version
    Given scenario "read" is validated
    Then Check "record review" runs Operation "method.review-write@1.0.0"
      on each "context record" as Input "record"
      using "observed revision" as Input "revision"
      and must establish "a receipt is stored for the observed context version"
      """js
      (fact.record === context["context record"] &&
       fact.revision === context["observed revision"] && fact.state === "recorded") ||
      fail("the receipt is absent or belongs to another context version")
      """
```

Root inputs: `{"context record":["EXPORT-42","IMPORT-21"]}`. Each write gets its
own record's observed revision through `for each` and `using`. Do not supply the
revision or description at engagement. The `read` prerequisite here deliberately
waits for all reads; use child Plans per record if independent progress is needed.

## 5. Verify in increasing scope

1. Compile each complete Operation with `trust_operation_compile({source})`.
2. Simulate the read with `trust_operation_simulate`; add `source` to these arguments:

```json
{
  "input": { "record": "EXPORT-42" },
  "environment": { "contextsUrl": "http://127.0.0.1:8099/contexts" },
  "steps": {
    "document": { "status": 200, "headers": {}, "body": {
      "document": { "id": "EXPORT-42", "revision": "r7",
        "content": { "description": "Automated consumer" } }
    } }
  }
}
```

Expected Produced: `{"record":"EXPORT-42","revision":"r7","description":"Automated consumer"}`.
For the write simulation, use Input `{record, revision}`, Environment `reviewsUrl`
and step `receipt` with `body.receipt` matching the sample response.

3. Exercise qualification in an authorized disposable dry-run, or the real Runner
   against a controlled service when live testing is assigned:

| Observation | Expected outcome |
| --- | --- |
| Matching read and matching stored receipt | Both Checks `VALIDATED` |
| Correctly typed but wrong document id | Read `NOT_VALIDATED`; write stays blocked |
| Empty description | Read `NOT_VALIDATED` |
| Receipt for another revision, or `state: "rejected"` | Write `NOT_VALIDATED` |
| Missing Produced `revision` | Reject the whole Fact batch; no qualification change |
| Transport interruption before accepted Facts | No qualification; use Runner recovery, never infer success |

Simulation verifies projection; it does not qualify a Check or prove persistence.
`actionOutcome` and HTTP 200 do not substitute for a TRUST verdict. See
[verification](../verify-and-test.md) for the public dry-run and live boundaries.

## 6. Configure and run only when assigned

Use `trust_environment_list` before `trust_environment_save`. Example ordinary
configuration (complete replacement map; preserve existing needed keys):

```json
{
  "environment": "local",
  "values": {
    "contextsUrl": "http://127.0.0.1:8099/contexts",
    "reviewsUrl": "http://127.0.0.1:8099/reviews"
  }
}
```

This does not start the example service. Use the actual authorized endpoint.
Check compatibility with `trust_operation_environment_list({source})`.
Do not put secrets in ordinary values: this HTTP contract does not inject secret
headers. Use an approved external adapter or a supported integration when the
real service requires authentication; do not invent Environment secret access.

With publication authorized, save Operations via `trust_operation_save` (immutable
publication despite its name), then publish the Procedure. Otherwise retain
drafts and validate in disposable resources. To run, follow the [execution
card](run-plan.md); a Trial performs real external actions outside a Plan.

For filesystem or SQL integrations the same mapping applies: external request →
complete Produced observations → Procedure qualification. Read the matching
canonical step contract rather than translating HTTP syntax by guesswork.

Details: [HTTP steps](../../../packages/trust-ui/src/docs/content/en/operations/steps/http.mdx),
[Produced projection](../../../packages/trust-ui/src/docs/content/en/operations/produce.mdx),
[Operation authoring](../author-operation.md).
