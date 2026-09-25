# Find and choose catalog Operations and Procedures — request

Date: 2026-09-23
Status: functional request and implementation trace. The product owner has fixed the boundary between the versioned method and editable catalog metadata. The first catalog increment is locally implemented and verified in this checkout; retained-runtime activation remains separate.

## User outcome

People and agents must be able to find the right reusable Operation or Procedure, understand when to use it, and distinguish it from similar entries as both catalogs grow. They must be able to improve an entry's human title, **existing description** and classification tags without publishing a new executable version. Both the interface and MCP catalog reads must make that information available for selection. This also makes near-duplicates easier to notice before authors add another definition.

The compiled Operation or Procedure remains fixed within one published version. The owner has explicitly separated that method from catalog metadata used to describe, classify and retrieve it. Current code couples some metadata to compilation and source immutability; changing that code is part of delivering the user outcome, not a reason to block it.

## First catalog increment

1. Give both resource kinds the same editable catalog surface: human title, the existing full description and add/remove/edit classification tags. Keep editorial revision history. Do not add a second description field or change SemVer for these edits.
2. Show those fields in Procedure and Operation catalog results and detail views, including MCP reads. Provide a basic query over canonical name, title, description and tags so a user or agent can narrow a growing catalog. Search ranking and semantic retrieval can evolve after the first usable query.
3. Review one proposed short discovery summary for each reusable entry later: **when to use it** and **what it establishes or produces**. It is a selection aid, not an execution input. Its exact format, length and whether publication requires it remain open; inline missions need not carry a catalog-publication requirement.

The first increment succeeds when a user can improve a catalog entry and then find that same entry through the interface or MCP without creating a new executable version. It does not require choosing a complete classification taxonomy or semantic-search ranking now.

## Functional boundary: what execution needs

Classify each field by its use, rather than by where the current code stores it. A field is versioned when changing it can change the requested external action, the accepted Fact shape, the Plan's work graph, the authorization boundary or Check qualification. Text used only to explain, organize or find a catalog entry is editable metadata.

| Resource | Data needed for execution and qualification; versioned | Data used for catalog discovery; editable |
| --- | --- | --- |
| Operation | Canonical name and selected version; Input, Environment and Produced schemas; ordered action steps and parameters; accepted outcomes; JSONata projection. A step name remains stable where the projection addresses it. | Human Feature title and existing description; proposed discovery summary; classification tags. Source filename and publication details are provenance. |
| Procedure | Canonical name and selected version; roles and sources; action scope; Scenario slugs and prerequisites; Check identifiers, selected Operation, target, bindings, deadlines, materializations, qualification and reasons; child Invocations and mission collections; intent chaining. | Human Feature title and existing description; proposed discovery summary; classification tags. Scenario display titles do not select prerequisites, although the current compiler still includes them in the digest. |

A Plan may retain the original source and catalog text as a readable historical snapshot. That does not make title, description or tags Runner inputs or qualification rules. The catalog can display a newer editorial revision without changing the Plan's pinned work or historic snapshot. The first implementation stores editorial revisions alongside immutable source snapshots; metadata updates do not recompile or recompute the existing executable digests.

## Baseline behavior before this catalog increment

| Concern | Operation today | Procedure today |
| --- | --- | --- |
| Reusable identity | `@operation:<domain>.<action>`; the two lower-case segments form one name across versions. | `@procedure:<slug>`; one lower-case slug across versions. Scenario `@scenario:<slug>` identifies a Scenario inside that Procedure, not a catalog entry. |
| Version and grammar | `@version:<exact SemVer>` identifies a published version; `@trust-dsl:1` selects grammar version. | Same roles for `@version` and `@trust-dsl`. References to Operations and child Procedures use quoted `name@selector`, with exact SemVer or node-semver ranges. |
| Human text | `Feature:` name becomes compiled `title`; the indented Feature text becomes optional compiled `description`. | Same, plus Scenario names become compiled Scenario titles. Procedure scope prose, Check names and success reasons, qualification failure reasons, role names, and declaration text participate in the executable method. |
| Other tags | Repeatable `@x-<key>:<value>` tags compile into `classification` arrays; key/value syntax is constrained but meaning is largely open. | Optional `@intent-chaining` changes Plan behavior. Procedure-level `@x-*` tags are currently rejected. Each Scenario requires `@scenario:<slug>`. |
| Executable content | Environment, Input and Produced schemas; ordered Shell/File/HTTP/PostgreSQL steps, acceptance conditions, and JSONata projection. | Scope, roles, mission collections, Scenario prerequisites, Checks and Invocations, bindings, deadlines, qualification guards, reasons, and resolved dependencies. |
| Persistence | One `.feature` file per published Operation version; `operation@version` and occupied filename cannot be replaced or deleted. | SQLite stores exact source, compiled JSON, definition digest, `sourceName`, publisher and publication time. Same `procedure@version` with changed source or digest is refused. |
| Digest | A Procedure's embedded Operation semantic digest excludes Operation `source`, but includes its title, description and classification. JSONata is hashed as a position-free AST. | `definitionDigest` excludes Procedure source, source positions, qualification formatting and Feature description. It includes the Feature title, Scenario titles, scope, roles, Checks, Invocations, reasons and embedded Operation semantics. Same-version source edits still fail publication even when the digest is unchanged. |
| Plan history | An engaged Plan retains its resolved compiled Procedure, embedded Operations, definition digest and source in revision history. | The same pinned composition governs delayed children, replacement generations and resumption. Catalog presentation edits must not rewrite that record. |

`sourceName` is a filename or diagnostic/provenance label, **not** resource identity. `publishedBy` and `publishedAt` are publication provenance, not authoring metadata. A configured registry source names an import location; its index identifies kind/name/version/path and verifies SHA-256 of the complete artifact bytes. That artifact checksum is an integrity check, not the executable semantic digest. Registry synchronization currently refuses changed bytes for an imported published version.

The baseline catalog projections exposed title and description for both kinds, and Operation classification. The Operation UI may infer family from the name's domain and nature from steps/name when tags are absent; Procedure family is inferred from used Operations. Those are presentation derivations, not stable field definitions. The catalog projection now carries current editorial metadata beside compiled definitions; MCP and UI use it for discovery while the original source remains available as history.

### Exact compiled field inventory

This inventory names the current public compiled fields. It records today's representation, then applies the functional boundary above. A value's presence in the current compiled payload does not by itself make it part of the versioned method.

| Operation field | Role today | Change boundary |
| --- | --- | --- |
| `contract` | Compiled payload format marker (`trust.compiled-operation@1`). | A format migration, not a catalog edit. |
| `operation`, `version` | Canonical catalog identity and exact release. | New identity or release. |
| `title`, `description` | Human Feature title and optional Feature prose stored in the compiled definition. | Editable catalog metadata; separate their revisions from the executable method. Keep the existing description rather than creating a duplicate. |
| `source` | Exact authored Gherkin retained with the definition. | Historical source snapshot; retain it for audit while separating metadata from executable comparison. |
| `input`, `environment` | Closed named input and Environment value schemas. | Executable contract: new version. |
| `steps` | Ordered named Shell, File Read, HTTP or PostgreSQL actions and their parameters. | Executable contract: new version. |
| `produce`, `produced` | JSONata projection and complete typed Fact schema. | Executable contract: new version. |
| `classification` | Optional grouped `@x-*` values compiled from source. | Editable classification metadata, including add/remove/correction without SemVer or recompilation. |

`input` and `produced` contain named fields, type/cardinality and, for Produced values, domain constraints. `steps` contain names and type-specific action definitions. These nested values are method, not free catalog tags. `sourceName` is a compile/publish diagnostic input and store provenance; it is not a `CompiledOperation` field.

| Procedure field | Role today | Change boundary |
| --- | --- | --- |
| `procedure`, `version` | Canonical catalog identity and exact release. | New identity or release. |
| `title`, `description` | Human Feature title and optional prose. | Editable catalog metadata; current digest/source coupling must be removed from executable comparison. |
| `intentChaining` | Plan intent behavior selected by the tag. | Executable contract: new version. |
| `source`, `definitionDigest` | Authored Gherkin snapshot and semantic digest. | Preserve historical source; derive the executable digest only from the method. Metadata edits do not recompile. |
| `operations` | Resolved embedded Operation name/version, digest and complete definition. | Pinned executable composition. |
| `scope` | Per-Check or global authorized/forbidden boundary. | Governing instructions: new version. |
| `roles` | Named typed values from Plan input, agent declaration, fixed value, Operation field, child Result or Plan identifier. | Input and result contract: new version. |
| `scenarios` | Stable slug, human title, dependencies, Check and Invocation membership. | Slug, dependencies and membership are method; the display title is descriptive text to separate from semantic comparison. |
| `checks` | Check name, Scenario, selected Operation, time constraint, target, input bindings, materialized roles, qualification and reason. | Executable/qualification contract: new version. |
| `invocations` | Resolved child Procedure, target, bindings, Result materialization and success reason. | Pinned composition: new version. |
| `missionCollections`, `declaredInvocations` | Dynamic child-mission slots and their Result bindings. | Parent workflow contract: new version. |

Source locations on roles, scope, Scenarios, Checks and Invocations are diagnostic positions. They are derived from source and excluded from the Procedure semantic digest; they do not create independent catalog identities. A Scenario title is human display text but currently enters the digest; this is a coupling to change. Plan metadata and publication provenance remain outside these compiled contracts.

## Proposed field contract

| Field | Meaning and authority | Proposed change rule |
| --- | --- | --- |
| Kind + canonical name | Stable machine identity within the Operation or Procedure catalog. The Operation domain is part of its name; it is not a free classification label. | A rename creates a different identity. No alias or silent migration is implied. |
| Exact SemVer | Author's compatibility promise for one immutable executable contract. The same name may have multiple versions. | New version for every executable-contract change; metadata-only edits keep the version. |
| DSL version | Parser/grammar compatibility marker, separate from resource SemVer. | Changing it requires recompilation and publication of a new resource version if the executable interpretation changes. |
| `Feature:` title | Human catalog label, distinct from the canonical Operation or Procedure name. The original compiled value enters current Procedure and embedded Operation digests. | Edit the current catalog presentation without SemVer or recompilation. Keep the original compiled value as history; changing the digest algorithm for published versions would need an explicit compatibility design. |
| Feature description | The existing authored explanatory text under `Feature:`. It gives purpose, assumptions and context; it is not a Runner command, qualification rule or Procedure scope. The original value is retained in compiled definitions and source and enters embedded Operation digests. | Edit the current catalog presentation for both resource kinds without SemVer or recompilation. Keep one current human description in the catalog and its original value in the source snapshot; do not add a second independently editable description. |
| Catalog summary | Proposed short discovery text distinct from the fuller existing description. No canonical field exists today. | Editable if added. Its shape, length and publication requirement are later catalog-content choices. |
| Catalog classification tags | Descriptors used to group and find resources. Existing Operation `@x-*` tags enter compiled definitions and embedded digests; Procedure-level `@x-*` tags are rejected. | Add, remove or correct tags on either kind without SemVer or recompilation. Their precise dimensions and controlled values are later catalog-design choices. |
| `@intent-chaining`, Scenario slugs, scope and action text | Procedure behavior, addressing and agent-facing constraints. A Scenario slug is referenced by prerequisites. | Versioned. Check names, references, prerequisites, scope, reasons and qualification remain fixed. Scenario display titles still belong to published source in this increment; changing their treatment needs a separate decision. |
| Operation schemas, steps and projection | Runner action and complete Fact shape. | Versioned. Changing only comments or formatting need not change behavior, but the published source remains immutable under the current rule. |
| `sourceName`, publication and registry provenance | Where the artifact came from, who published it and when, and which bytes were verified. | Record as provenance/history; do not use as identity or editable catalog classification. |
| Plan metadata | `title`, labels and annotations supplied at engagement for one Plan. | Belongs to the Plan, not the reusable Procedure or Operation; remains governed by the existing Plan metadata rules. |

The model separates the **immutable executable revision** (`kind/name@version`, compiled method and semantic digest), **editable editorial revisions** (human title, existing description and classification tags, with history), and **import provenance** (source location, checksum and synchronization event). The current implementation keeps original source bytes and stores subsequent editorial revisions separately, per exact `kind/name@version`. A later authoring format may present both in one multiline header, but cannot silently replace the published source or registry artifact checksum. An editorial update does not recompile or change the executable contract. An engaged Plan keeps its original resolved method and readable source snapshot.

## Proposed SemVer rule for both kinds

1. Any change to the executable contract publishes a new version under the same canonical name. This includes changed Check or Scenario prerequisites, qualification, scope, success/failure reasons, mission or role rules, Operation Input/Environment/Produced schemas, steps, accepted outcomes, projection, external side effects, and dependency selection encoded in source. A published version is never replaced or deleted.
2. Choose **major** for a breaking caller or operator contract, including removed/renamed fields or roles, stricter required input, changed meaning of an existing Fact, newly required completion work, or an incompatible side effect. Choose **minor** for an additive capability that existing consumers can still use. Choose **patch** for a compatible correction that preserves the declared interface and intended result. These are author commitments subject to review, not compiler proof; even a patch version is a distinct immutable executable revision.
3. Exact and range references keep existing node-semver behavior: select the highest matching version, then validate compatibility; never fall back silently. A new Plan pins its selected recursive composition. An existing Plan never acquires a newer executable version through an editorial update or later publication.
4. An approved editorial-only update creates a catalog metadata revision, not a SemVer release. Its permitted fields must be an explicit allowlist. A mixed editorial/executable edit follows the executable publication path; metadata cannot mask a changed method.
5. Comments and whitespace in unpublished drafts may be edited freely. Whether to allow corrected source comments after publication is a separate audit decision: doing so changes artifact bytes and Plan-visible source even when the semantic digest is stable. The safe initial rule is to retain the published source and put corrections in editorial metadata.

## Decisions implemented and questions left open

- The owner approved the same editorial allowlist for both catalogs: human title, the existing Feature description and classification tags. No short summary field or required publication summary has been approved.
- The first increment stores editorial revisions for each exact `kind/name@version`. Revision 0 is derived from the published source; later revisions use optimistic `expectedRevision`, timestamp and complete field values. A new version initializes from its own source. The original source and each Plan snapshot remain unchanged.
- Current source authoring continues to produce an immutable artifact. Catalog corrections use the editorial update path. A multiline source header remains a possible future authoring format; no new header grammar or registry metadata synchronization is implied.
- Registry sync continues to verify full published artifact bytes. Local editorial revisions are not exported by the current registry index; cross-runtime metadata exchange needs a separate design.
- Actor and reason fields, version-level versus identity-level inheritance, a summary format, controlled tag vocabulary, duplicate detection and semantic ranking remain open. They must not be inferred from the first increment.

## Verification and activation

- Runtime public acceptance: 8/8 pass. Both resource kinds can be edited and found by text and tags after a restart on a disposable database; history and revision conflict work; published sources and a previously engaged Plan remain byte-identical.
- MCP public acceptance: 3/3 pass. Both catalog queries and metadata updates work, stale revisions are rejected, and original source is preserved.
- UI public acceptance: 1/1 pass on isolated browser-test ports. Both resource kinds can be edited from their detail views and found through updated text and tags.
- Integrated documentation acceptance: 9/9 pass; four affected screenshot groups were regenerated in both languages and themes (16/16 capture checks). Runtime and UI typechecks/builds pass. `code-moniker check . --report` found 0 violations across 607 scanned files; `git diff --check` passes.
- Schema activation: a new empty database has the catalog revision table. An existing database requires the explicit additive upgrade command in `packages/trust-runtime/scripts/upgrade-catalog-metadata.mjs`, which verifies the exact prior digest, creates and verifies a consistent backup, adds only the revision table, checks integrity and retains every existing row. The retained shared development database must be handled under its local-runtime protocol, not reset.

## Companion mission draft

`2026-09-23-catalog-definition-versioning-mission.feature` is an unpublished inline Procedure for a bounded delegated task in this change. It uses the existing coordination mission Operations to persist a request, claim, response and observed outcome. The coordinator supplies the exact implementation or review instructions and expected deliverable through its root Inputs. A `completed` response proves that the assigned agent submitted a response, not that the product owner accepted its contents.

Using it as an inline mission requires an already engaged parent Plan with a declared mission collection, the four `coordination.mission-* @1.0.0` Operations in the target catalog, a compatible Environment and separately authorized host dispatch. The parent would submit its full source as `definition.kind: "inline"`; the draft file is not a catalog publication or a Plan engagement. The connected runtime used for this review lacks those coordination Operations, so its public compile endpoint refuses at `create mission` with `unknown-operation`. A local compile against all repository Operation sources succeeded with four Checks and the four exact coordination Operation versions. That proves source compatibility with this checkout, not live mission admission or execution.

## Design trace

The Maket Structured Workspace **TRUST — Catalog metadata and versioning** holds dated, revisioned work records for the request, field inventory, code impacts, owner decisions, implementation, execution and follow-up observations after execution. It is a design trace, not a replacement for this repository request or a TRUST Plan. Add execution or follow-up records only when those events have actually occurred. Cite actual public acceptance and runtime evidence; do not infer a TRUST Check verdict from a Maket record status.

## Code and reference anchors

`packages/trust-operation/src/operation.ts`, `src/compile.ts`; `packages/trust-procedure/src/procedure.ts`, `src/compile.ts`; `packages/trust-runtime/src/operation/catalog.ts`, `src/procedure/store.ts`, `src/procedure/procedures.ts`, `src/registry/service.ts`, `src/plan/build.ts`, `src/plan/store.ts`; `packages/trust-runtime/src/http/rpc.ts`, `src/http/mcp-authoring.ts`; `packages/trust-ui/src/resources/operations/classification.ts`, `src/resources/procedures/model.ts`; `docs/todo/resource-versioning.md`.
