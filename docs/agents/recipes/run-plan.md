# I want to resume an assigned Plan

| Situation | Action | Check the result |
| --- | --- | --- |
| Given a Plan identifier | `trust_plan_read({plan})` | Assigned scope, revision, declarations, blockers, children, available URIs |
| Given a Check URI | `trust_plan_read({checkUri})` | The owning Plan, not a guessed parent |
| Required agent declaration missing | `trust_plan_declarations_replace({plan, expectedRevision, declarations})` | Complete allowed declaration snapshot, current revision; [related example](related-context.md) |
| Unknown work needs a child | [Declare a mission](delegation.md) | Accepted child identifier; dispatch is separate |
| A Check can run | Invoke the packaged Runner with the exact supplied URI | Read structured result, then current Plan |
| A dependency or child is still open | Execute only assigned available work, or report the blocker | Do not bypass admission or fabricate observations |
| A failed method needs operator judgment | Use the Runner's escalation path | Latest `NOT_VALIDATED` attempt and useful reasons |

Read the [Runner skill](../../../assets/skills/trust/SKILL.md) for its installed
path, intention placeholders and continuation protocol. Invocation shape:

```sh
node <runner-skill>/scripts/run.js '<supplied-check-uri>' --json
```

`<runner-skill>` and `<supplied-check-uri>` are substitutions, not literal values.
Do not reconstruct a Check URI from a name or run its external action separately.

| Runner result | Meaning / next step |
| --- | --- |
| `result.status: "COMPLETED"`, `result.qualification.verdict: "VALIDATED"` | Accepted Facts satisfy this Check; read the current Plan for continuation |
| `COMPLETED` with `NOT_VALIDATED` | Accepted observations fail the method's criterion; inspect its reason and the permitted next step |
| `REFUSED`, interruption or no accepted Facts | No qualification change; resolve the reported blocker or follow Runner recovery |
| Process exit code 0 | A structured response was returned; this alone is not success |

An accepted Fact batch must satisfy the Operation's complete Produced schema.
Missing one field rejects the batch atomically. Read the Check and follow the
installed Runner's recovery path; never emit live Facts manually. Re-observation
and resubmission can avoid repeating a known action when supported, but the generic
Runner may execute the Operation again on retry. Do not invent an observation-only
CLI. An unknown outcome for an action that cannot safely be replayed requires
explicit intervention.

New accepted observations can reopen dependent Checks. A worker saying “done”
does not close the parent; its current child validation and returned Results do.

Details: [execution and coordination](../execute-and-coordinate.md),
[Runner results and recovery](../../../assets/skills/trust/references/results.md).
