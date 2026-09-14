import { templateConstraints } from "@trust/extension-sdk";

const id = { type: "string", pattern: "^[a-z][a-z0-9-]{0,95}$" };
const expectedRevision = { type: "integer", minimum: 1 };

export function templateTools(): readonly unknown[] {
  return [
    {
      name: "trust_template_list",
      title: "List templates",
      description: "List saved reusable text templates. The catalog starts empty.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: "trust_template_read",
      title: "Read a template",
      description: "Read template content, parameters and current revision before editing or rendering.",
      inputSchema: { type: "object", properties: { id }, required: ["id"], additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: "trust_template_save",
      title: "Save a template",
      description:
        "Create or replace a user text template. Use expectedRevision 0 to create and the current revision to edit. Parameters must exactly cover {{name}} placeholders. This does not publish or execute content.",
      inputSchema: {
        type: "object",
        properties: {
          id,
          title: { type: "string", minLength: 1, maxLength: 200 },
          description: { type: "string", maxLength: 4000 },
          body: { type: "string", minLength: 1, maxLength: templateConstraints.bodyMaxLength },
          expectedRevision: { type: "integer", minimum: 0 },
          parameters: {
            type: "array",
            maxItems: templateConstraints.parameterMaxCount,
            items: {
              type: "object",
              properties: {
                name: {
                  type: "string",
                  pattern: `^${templateConstraints.parameterNamePattern}$`,
                  maxLength: templateConstraints.parameterNameMaxLength,
                },
                description: { type: "string", maxLength: templateConstraints.parameterDescriptionMaxLength },
                defaultValue: { type: "string", maxLength: templateConstraints.valueMaxLength },
              },
              required: ["name", "description"],
              additionalProperties: false,
            },
          },
        },
        required: ["id", "title", "description", "body", "parameters", "expectedRevision"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    {
      name: "trust_template_remove",
      title: "Delete a user template",
      description:
        "Remove a user template at its current revision. Materialized drafts and existing Plans remain independent.",
      inputSchema: {
        type: "object",
        properties: { id, expectedRevision },
        required: ["id", "expectedRevision"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    {
      name: "trust_template_render",
      title: "Instantiate a template",
      description:
        "Render the selected revision using literal text values and declared defaults. Returns source without compiling, publishing or executing it. Values are substituted once, without expression evaluation or automatic language escaping. Review the draft and use the relevant compiler for complete Operation or Procedure sources; inline missions accept the same generated source.",
      inputSchema: {
        type: "object",
        properties: {
          id,
          expectedRevision,
          values: {
            type: "object",
            additionalProperties: { type: "string", maxLength: templateConstraints.valueMaxLength },
          },
        },
        required: ["id", "expectedRevision", "values"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
  ];
}
