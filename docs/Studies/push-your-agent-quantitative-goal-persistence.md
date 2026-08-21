# Push Your Agent: quantitative goal persistence in long-horizon agents

**Study:** Yuandao Cai, Yuzhang Zhu, Liyou Gao, Wensheng Tang and Shengchao Qin,
“Push Your Agent: Measuring and Enforcing Quantitative Goal Persistence in Long-Horizon LLM
Agents”  
**Version:** arXiv:2605.23574v1, submitted 22 May 2026  
**URL:** https://arxiv.org/abs/2605.23574  
**Status:** preprint

## Research question

The study examines whether a language-model agent continues working until an externally verified
quantitative objective is complete.

It calls this property **Quantitative Goal Persistence (QGP)**. A task is complete only when an
external verifier has accepted at least a target number of distinct valid work units. The agent's
final claim does not determine success.

The study separates this persistence problem from local competence. An agent may find or complete
valid units and still fail the overall task by:

- stopping before the target is reached;
- claiming completion with insufficient verified progress;
- submitting the same unit repeatedly;
- repeating work that has already passed;
- failing to use verifier feedback to resume pending work.

## Experimental mechanism

The benchmark, PushBench, fixes for each run:

- a task objective;
- a target count;
- an interaction budget;
- a hidden set of valid items or deterministic unit checkers;
- an external verifier that owns the accepted progress state.

Two controlled task families are evaluated.

### QGP-RepoScan

The agent searches local snapshots of the requests, pytest and flask repositories and submits stable
artifact identifiers. The verifier accepts only distinct identifiers satisfying the hidden task
predicate.

Target counts are 10, 25, 50 and 100, with respective interaction budgets of 30, 60, 100 and 180.

### QGP-DataOps-lite

The agent processes a backlog of small verifier-backed units. A unit may require inspection, a small
edit or structured answer, execution of a deterministic checker and submission of the accepted
result.

Target counts are 3, 5, 10 and 20, with respective interaction budgets of 30, 50, 90 and 160.

The units are intentionally low-to-medium difficulty. The experiment is designed to isolate
persistence and progress-state failures rather than general software-engineering ability.

## Controllers compared

### Standard controller

The controller executes parsed agent actions without maintaining duplicate-aware persistence state
or preventing unsupported termination.

### Verifier-gated controller

The controller refuses a final or ask-user action while the verified count is below the target. It
does not otherwise maintain or exploit detailed progress state.

### StateQGP

StateQGP maintains controller-visible state for repository retrieval:

- submitted identifiers;
- duplicate submissions;
- search pages already seen;
- the last query;
- the next unseen page;
- the verified count and remaining target.

It filters duplicate identifiers, advances repeated searches to unseen pages, repairs empty
duplicate-only submissions into further search and blocks termination before the verified target is
met.

### UnitQGP

UnitQGP maintains controller-visible backlog state:

- pending units;
- attempted units;
- passed units;
- stale inspection or no-submission loops;
- verifier recovery after a repaired attempt.

It routes execution back to unfinished work and steers post-edit behaviour toward checker execution
and verifier-backed submission.

## Results demonstrated by the study

### Repository retrieval

Across matched model and backend comparisons, StateQGP reaches success rates from 69.4% to 77.8%.
It records a duplicate-submission rate of zero in every reported StateQGP row.

For GPT-5.4:

- Native standard reaches 30.6%, verifier-gated 47.2% and StateQGP 69.4%;
- LangGraph standard reaches 16.7%, verifier-gated 22.2% and StateQGP 77.8%.

The matched comparisons keep the task, model, backend, budget, verifier and valid set fixed. The
observed difference is therefore attributable to the controller intervention within this benchmark.

The ablation also shows that duplicate filtering alone does not explain the result. Page memory
improves success, but the complete verifier-aligned state controller performs better than the
isolated state components.

### Verifier-backed work units

In QGP-DataOps-lite, the standard and verifier-gated controlled agents complete no full task
instance across the reported models and backends.

UnitQGP reaches:

- 50% success with GPT-4.1-mini;
- 29.2% with GPT-4.1;
- 25% with GPT-5.4.

This demonstrates that refusing unsupported completion is not sufficient in these conditions.
Maintaining and exploiting the verifier-visible backlog state changes the execution outcome.

### Frontier coding agents

In the black-box RepoScan evaluation, Claude Code with Sonnet 4.6 and Codex CLI with GPT-5.4 each
solve seven of nine tasks at a target of 50 artifacts. Every agent and prompt condition falls to
three of nine tasks at a target of 100 artifacts.

Adding an explicit checklist prompt produces no paired improvement in task success. The study
therefore finds that a textual reminder to track progress is not equivalent to controller-maintained
verifier-aligned state.

## What the study establishes

Within its controlled tasks, the study provides empirical evidence that:

1. local successful actions do not guarantee completion of a long quantitative objective;
2. progress derived from an external verifier is more reliable than progress claimed by the agent;
3. keeping verifier-aligned progress state in a software controller can materially change the
   agent's trajectory;
4. completion gating alone can prevent a false completion without making the agent capable of
   finishing;
5. generic memory and checklist prompting do not uniformly replace a controller that maintains and
   exploits verified progress state.

## Limits

The study does not establish general agent reliability.

Its main experiments use three repository snapshots, small deterministic work units, fixed budgets
and online verifiers. The coding-style and frontier-agent evaluations add realism but also introduce
uncontrolled harness behaviour, memory, prompting and tool routing.

The study does not test:

- TRUST;
- Gherkin Procedures;
- semantic dependencies between work units;
- typed external Facts;
- qualification invalidation;
- coordination across Sessions;
- external actions with operational side effects;
- the correctness or authority of an external verifier.

QGP progress is also monotonic and quantitative: accepted distinct units accumulate toward a target
count. It does not examine a previously accepted qualification becoming inactive after a dependency
changes.

## Relationship with TRUST

The study provides no direct empirical validation of TRUST because TRUST is not part of its
experimental system.

It does, however, provide direct experimental support for the controller principle with which TRUST
is aligned:

> A long-running agent should not own its completion state. A visible software controller should
> maintain progress from externally verified results and prevent unsupported progression.

TRUST applies this principle to procedural objectives. The Plan persists the objective and its
current progress outside the agent. Checks identify the remaining governed work. Accepted Facts and
compiled predicates determine qualification. The agent cannot advance the Plan through a completion
claim, and an Action is not treated as progress merely because it was attempted.

In this sense, TRUST is aligned with the external verifier-backed controllers tested in the study.
Both approaches make verified progress a runtime concern rather than a conversational responsibility
of the language model. This is the factual connection supported by the paper.

The alignment is architectural, not an equivalence:

- PushBench measures progress toward a target count of independent valid units;
- TRUST maintains semantic qualifications and dependencies defined by a published Procedure;
- StateQGP and UnitQGP contain benchmark-specific steering and repair policies;
- TRUST exposes and enforces actionable procedural state without the study having evaluated its
  particular semantics.

## Conclusion

“Push Your Agent” demonstrates that long-horizon agents can lose a quantitative objective despite
making valid local progress, and that a software controller maintaining verifier-aligned progress
can improve completion substantially.

TRUST follows the same validated direction: it externalizes the objective and its verified progress,
maintains them across a long run and prevents the agent from treating its own activity as completion.

The study therefore supports the rationale for TRUST as an external controller of persistent,
verified progress. It does not demonstrate the effectiveness of TRUST itself or validate the
additional procedural semantics implemented by TRUST.
