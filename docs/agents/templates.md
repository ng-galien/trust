# Create and instantiate templates

Use this task for reusable text authoring: complete Procedures or Operations, inline mission source, policy fragments, Markdown, JSON or YAML. A template is editable authoring content, not a published Procedure or a new execution contract.

## Select or author a template

1. Call `trust_template_list`, then `trust_template_read` with `id` for the selected template. Read its body, parameter definitions and current revision.
2. To create one, call `trust_template_save` with a new lowercase slug `id`, `title`, `description`, `body`, `parameters`, and `expectedRevision: 0`.
3. Declare every `{{name}}` placeholder exactly once in `parameters`, using `name`, `description`, and an optional `defaultValue`. Names use letters, digits and underscores and start with a letter. No expression evaluation or recursive substitution is supported. Declare no unused parameters.
4. To edit, read the current template and save its complete replacement with that `expectedRevision`. On conflict, reread and reconcile the changes. To duplicate a template, copy its fields under a new id with revision zero.

## Instantiate and use the result

1. Call `trust_template_render` with `id`, its current `expectedRevision`, and `values`. Supply every parameter without a default; omit values when selecting their defaults. An explicit empty string is a value, including an explicitly declared empty default. In the UI, enable default presence separately; clearing its text preserves the empty default. Unknown parameters are refused.
2. Review the returned `source`. Values are literal text; apply the destination language's escaping when needed. Rendering does not validate Gherkin, JSON or YAML and never executes, publishes or engages anything.
3. For a complete Operation or Procedure, use the existing compiler and review the draft before the separately authorized publication or engagement. For an inline mission, use the generated Procedure source as `definition.procedureSource` and provide its Operation sources normally.
4. For a fragment, merge it deliberately with the existing draft. Preserve its scope, invariants and Checks; do not replace a complete Procedure with a policy fragment.

The interface's **Templates** page supports the same catalog, editing, duplication, parameter entry and preview. The Procedure editor can preview a selected template and explicitly replace its draft with the rendered source. The existing editor and LSP then validate that source normally, without scanning already materialized text for parameters. Runtime and LSP consume the same template validation and substitution owner. Scope-fragment assistance checks exactly one canonical Procedure scope step; additional declarations or Scenarios require a complete Procedure and are reported as unsupported.

## Select useful source material

The catalog starts empty. Derive a template from an actual reusable source and its authorized workflow. Identify what varies and parameterize only those values. Do not seed demonstration content into a user catalog or describe prose instructions as runtime enforcement.

## Removal and completion

For authorized removal, call `trust_template_remove` with the id and current revision. Already rendered text and accepted missions remain independent of the template. Template edits or removal do not rewrite Plan history.

Report the template identity, revision and rendered draft or separately authorized publication/mission. Do not treat saved or rendered text as behavioral evidence, a TRUST verdict, or proof of agent compliance.
