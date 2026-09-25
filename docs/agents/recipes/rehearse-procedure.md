# I want to rehearse qualification without an external action

Use a dry-run when you need to test context binding, dependencies and verdicts.
For a design exercise, a clear modeled example may be sufficient; this rehearsal
is an optional behavioral verification, not a prerequisite for proposing a method.

## 1. Isolate the runtime and the catalog

In a TRUST checkout with the runtime already built, start an isolated process:

```sh
validation_dir=$(mktemp -d)
mkdir "$validation_dir/operations"
TRUST_HOST=127.0.0.1 TRUST_PORT=0 \
TRUST_STORAGE=pglite TRUST_PGLITE_DIRECTORY="$validation_dir/pglite" \
TRUST_OPERATIONS_DIRECTORY="$validation_dir/operations" \
node packages/trust-runtime/dist/src/index.js
```

The process prints its actual endpoint. Keep it running while testing; stop this
process afterward. Both the database **and the Operation catalog directory** must
be temporary. `trust_operation_save` writes source files to that directory;
isolating only the database would still modify a shared catalog. Do not use the retained
development runtime. Outside a checkout, use the installed runtime entrypoint.

On this temporary endpoint, compile and save the exact draft Operations with MCP,
then compile and publish their Procedure. Supply the necessary dependency sources;
an empty catalog contains no Jira or Git Operation. These publications belong
only to the disposable test runtime. For testing inline missions, leave their
Procedure/Operation identities unpublished and pass their sources in the mission.

## 2. Engage through public RPC

All following objects are JSON-RPC request bodies sent by HTTP POST to this
runtime's `/rpc`, with `Content-Type: application/json`. Inspect `error` before
using `result`. This example uses the sources from [external I/O](external-io.md).

```json
{"jsonrpc":"2.0","id":1,"method":"environment.save","params":{
  "environment":"rehearsal","values":{}
}}
```

```json
{"jsonrpc":"2.0","id":2,"method":"plan.engage","params":{
  "contract":"trust.plan-engagement-request@1",
  "procedure":"record-context-review","procedureVersion":"1.0.0",
  "plan":"context-rehearsal","environment":"rehearsal","mode":"dry-run",
  "rootInputs":{"context record":["EXPORT-42"]}
}}
```

```json
{"jsonrpc":"2.0","id":3,"method":"plan.read","params":{
  "plan":"context-rehearsal"
}}
```

Use the read Check's actual `checkUri` from this response. Environment values are
not delegated in dry-run; the empty Environment is intentional. MCP engagement
is live-only: do not add an unsupported `mode` field to `trust_plan_engage`.

## 3. Admit, supply complete operator Facts, finalize

This JavaScript fragment assembles exact request bodies. `checkUri` is the URI
just read; `rpc(method, params)` means POST a JSON-RPC envelope as above and return
its `result`, rejecting an error. It is a local helper, not an SDK function.

```javascript
const admission = await rpc("check.attempt.admit", {
  contract: "trust.check-admission-request@1",
  checkUri,
  attemptKey: "rehearsal-read-1",
});
if (admission.status !== "ADMITTED") throw new Error("Attempt refused");
const observedAt = new Date().toISOString();
await rpc("check.attempt.facts", {
  contract: "trust.fact-batch-request@1",
  attemptKey: admission.attemptKey,
  attemptHandle: admission.attemptHandle,
  executionId: admission.executionId,
  checkUri: admission.checkUri,
  recordedAt: observedAt,
  facts: [{
    kind: admission.operation.operation,
    observedAt,
    values: {
      record: "EXPORT-42",
      revision: "r7",
      description: "Automated consumer",
    },
  }],
});
const qualification = await rpc("check.attempt.finalize", {
  contract: "trust.attempt-finalization-request@1",
  attemptHandle: admission.attemptHandle,
});
```

Expect `qualification.verdict === "VALIDATED"`. Read the Plan: the write Check
must now bind `{"record":"EXPORT-42","revision":"r7"}`. Repeat admission with
that Check URI and a new attempt key; its complete Produced values are
`{"record":"EXPORT-42","revision":"r7","state":"recorded"}`.

These are explicit **synthetic operator Facts for dry-run only**. They do not
prove an HTTP GET/POST happened. Live Facts come from the Runner through OTLP.

## 4. Change one observation and inspect the actual outcome

| Case | Request change | Expected result |
| --- | --- | --- |
| Negative read | `description: ""` | `NOT_VALIDATED`; dependent write blocked |
| Wrong receipt | `revision: "other"` in the write's Facts | `NOT_VALIDATED` |
| Incomplete batch | Omit `revision` | `check.attempt.facts` refuses atomically; no new qualification |
| Revisit a satisfied Check | Add `reobserve: true` at admission in this dry-run | New qualification can reopen dependent Checks |

Use a new attempt key for each new attempt. After a refused incomplete batch,
inspect state; a pending test attempt can be closed with public RPC
`check.attempt.interrupt({contract:"trust.attempt-interruption-request@1", attemptHandle})`.
An interruption is not a negative verdict. Use the real admission fields rather
than reconstructing handles or identifiers.

For a direct reproducible contract example in the checkout, see the
[public dry-run acceptance](../../../packages/trust-runtime/acceptance/plan-dry-run.acceptance.test.ts).
That source is a deeper reference; the requests above suffice for this rehearsal.
