# TRUST procedure language

Every published `.feature` is autonomous and carries the mandatory `@trust-dsl:1` language tag. It
declares the procedure roles, exact required Skill capabilities, stable typed ports, authentic
observations, output projections, named Checks, bindings,
qualification and semantic feedback. A Check uses one Skill capability. There is no complementary
business catalog and no procedure configuration loaded when the server starts.

The active product vocabulary is:

```text
Feature publication
  → exact capability requirements
  → Plan + Sessions
  → OPEN or SATISFIED Checks
  → Skill capability + exact Action Contract
  → authentic Facts
  → VALIDATED or NOT_VALIDATED
```

The closed language is specified in [GRAMMAR.md](GRAMMAR.md). The current product slice is
[01-defect-correction-multi-project.feature](01-defect-correction-multi-project.feature):
ten non-polymorphic capabilities used by twelve Check templates and implemented by six autonomous
Skills. Each capability is declared once in the Feature and may be reused by several named Checks with
different local role-to-port bindings.

The dependency language is deliberately limited to Scenario prerequisites and typed observations
read from named upstream Checks. New accepted Facts replace the current qualification and
recursively reopen consumers without introducing another public state beyond `OPEN` and
`SATISFIED`.

Compilation and publication accept only the Feature source and source name. A Feature can be
published and a Plan engaged before any Skill is registered. Skills later register exact claims for
`(capability, actionContractDigest)`; registration is not authorization.

Compiler rejection examples live in public runtime acceptances. No parallel fixture manifest,
business catalog or suite corpus is loaded by the compiler or runtime.
