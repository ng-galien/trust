# React hook transition guidance

Do not apply dependency autofixes or suppress the rule without inspecting the
lifecycle transition. Apparently extra dependencies may encode resource identity,
retry, selection or live refresh. Verify behavior through public browser journeys.

The table records transition requirements and design options. It is not an
execution report or a claim that an implementation remains unfinished.

## Transition requirements

| Site | Intended transition and risk | Proposed direction / public acceptance |
| --- | --- | --- |
| coordination/filter-bar | Retry same failed request; removing retry breaks it | Explicit request identity; failed request, retry, rapid typing cancellation |
| coordination/page tag editor | Reset on selection, not live refresh | Resource-keyed state; selection/back resets, refresh retains draft |
| coordination/page detail | Refetch same Plan on revision | Explicit request generation; SSE intent update and stale-response cancellation |
| docs-area scroll | New path/hash scroll | Page-scoped layout synchronization; new page, anchor, back |
| docs-area mobile navigation | Close on route transition | Route-owned open state; click and browser history |
| gherkin-editor markers | Apply on actual editor readiness | Reactive editor instance; initial mount and model replacement |
| gherkin-editor decorations | Reapply on readiness, dispose old collection | Instance-owned cleanup; remount and decoration changes |
| environments-home draft | Initialize selected environment without clobbering edits | Decide dirty refresh/conflict policy; new/item/async loading transitions |
| run-view environment | Default from context but retain manual compatible choice | Reconcile the two effects; context change versus manual selection needs explicit policy |
| run-view output | Follow arriving output only when enabled | DOM synchronization; new chunks, follow off/on |
| plan-console declarations | Refresh pristine values, retain dirty values | Derived pristine value plus draft override; revision conflict acceptance |
| plan-console next intent | Reset on Check/current-intent change only | Key this field, not entire Facts form; unrelated revision retains input |
| plan-engage inputs | Reset procedure-specific inputs | Key input form; route/back transition preserves unrelated metadata |
| plan-engage environment | Fill only empty selection using current context | Capture current context; asynchronous load must not replace manual choice |
| procedure-graph viewport | Center on selection, not every pan | Selection event reads latest viewport; manual pan must remain stable |
| procedure-simulation | Reset completion on definition change | Definition-keyed state; same definition refresh retains progress |
| source-draft | Reset resource/version/duplication identity, retain tab changes | Identity-owned draft; version/back/async source transitions; preserve current discard-not-cache behavior unless approved |
| schema validity | Notify by issue contents, avoid callback feedback loop | Content snapshot or parent-owned validation; invalid/valid transitions and fresh equivalent schema |

Do not introduce broad memoization, refs, or Effect Events to hide dependencies.
Effect Events are an option only for genuinely non-reactive event logic (such as
selection-triggered viewport inspection), subject to separate review.

References: [useEffect](https://react.dev/reference/react/useEffect),
[removing dependencies](https://react.dev/learn/removing-effect-dependencies),
[derived state](https://react.dev/learn/you-might-not-need-an-effect),
[Effect Events](https://react.dev/reference/react/useEffectEvent).
