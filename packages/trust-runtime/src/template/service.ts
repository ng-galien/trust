import type {
  SourceTemplate,
  TemplateParameter,
  TemplateRenderResult,
  TemplateSaveRequest,
} from "@trust/extension-sdk";
import {
  materializeTemplate,
  TemplateDefinitionError,
  validateTemplateDefinition,
  validateTemplateParameters,
} from "@trust/extension-sdk";
import type { Database, SourceTemplateTable } from "../database/database.js";

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateError";
  }
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, limit: number, empty = false): value is string =>
  typeof value === "string" && value.length <= limit && (empty || value.trim().length > 0) && !value.includes("\0");
function keys(value: unknown, allowed: readonly string[]): asserts value is Record<string, unknown> {
  if (!record(value) || Object.keys(value).some((key) => !allowed.includes(key)))
    throw new TemplateError("Invalid template request fields");
}
function id(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]{0,95}$/u.test(value))
    throw new TemplateError("Template id must be a lowercase slug (up to 96 characters)");
}
function revision(value: unknown, allowZero = false): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < (allowZero ? 0 : 1))
    throw new TemplateError("Invalid expectedRevision");
}
function parseSave(value: unknown): TemplateSaveRequest {
  keys(value, ["id", "title", "description", "body", "parameters", "expectedRevision"]);
  id(value.id);
  revision(value.expectedRevision, true);
  if (!text(value.title, 200) || !text(value.description, 4000, true) || typeof value.body !== "string")
    throw new TemplateError("Invalid template title, description, body or parameters");
  let parameters: TemplateParameter[];
  try {
    parameters = validateTemplateParameters(value.parameters);
    const issue = validateTemplateDefinition(value.body, parameters)[0];
    if (issue) throw new TemplateDefinitionError(issue.message);
  } catch (error) {
    if (error instanceof TemplateDefinitionError) throw new TemplateError(error.message);
    throw error;
  }
  return {
    id: value.id,
    title: value.title,
    description: value.description,
    body: value.body,
    parameters,
    expectedRevision: value.expectedRevision,
  };
}
function view(row: SourceTemplateTable): SourceTemplate {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    body: row.body,
    parameters: JSON.parse(row.parameters_json) as TemplateParameter[],
    revision: row.revision,
    builtIn: false,
  };
}

/** Shared authoring service. Rendering never publishes or executes its output. */
export class TemplateService {
  constructor(private readonly dependencies: { readonly database: Database }) {}

  async list(input: unknown = {}): Promise<SourceTemplate[]> {
    keys(input, []);
    const stored = await this.dependencies.database
      .selectFrom("source_templates")
      .selectAll()
      .where("deleted", "=", 0)
      .orderBy("id")
      .execute();
    return stored.map(view).sort((a, b) => a.title.localeCompare(b.title));
  }

  async read(input: unknown): Promise<SourceTemplate> {
    keys(input, ["id"]);
    id(input.id);
    const row = await this.dependencies.database
      .selectFrom("source_templates")
      .selectAll()
      .where("deleted", "=", 0)
      .where("id", "=", input.id)
      .executeTakeFirst();
    if (!row) throw new TemplateError(`Unknown template ${input.id}`);
    return view(row);
  }

  async save(input: unknown): Promise<SourceTemplate> {
    const draft = parseSave(input);
    const values = {
      deleted: 0,
      id: draft.id,
      title: draft.title,
      description: draft.description,
      body: draft.body,
      parameters_json: JSON.stringify(draft.parameters),
      revision: draft.expectedRevision + 1,
    };
    return this.dependencies.database.transaction().execute(async (transaction) => {
      if (draft.expectedRevision === 0) {
        const inserted = await transaction
          .insertInto("source_templates")
          .values(values)
          .onConflict((conflict) =>
            conflict
              .column("id")
              .doUpdateSet({ ...values, revision: (eb) => eb("source_templates.revision", "+", 1) })
              .where("source_templates.deleted", "=", 1),
          )
          .returningAll()
          .executeTakeFirst();
        if (!inserted) throw new TemplateError("Template revision conflict; read the current template before saving");
        return view(inserted);
      }
      const updated = await transaction
        .updateTable("source_templates")
        .set(values)
        .where("id", "=", draft.id)
        .where("revision", "=", draft.expectedRevision)
        .where("deleted", "=", 0)
        .returningAll()
        .executeTakeFirst();
      if (!updated) throw new TemplateError("Template revision conflict; read the current template before saving");
      return view(updated);
    });
  }

  async remove(input: unknown): Promise<{ removed: boolean }> {
    keys(input, ["id", "expectedRevision"]);
    id(input.id);
    revision(input.expectedRevision);
    const result = await this.dependencies.database
      .updateTable("source_templates")
      .set({
        deleted: 1,
        title: "",
        description: "",
        body: "",
        parameters_json: "[]",
        revision: (eb) => eb("revision", "+", 1),
      })
      .where("id", "=", input.id)
      .where("revision", "=", input.expectedRevision)
      .where("deleted", "=", 0)
      .executeTakeFirst();
    if (result.numUpdatedRows === 0n)
      throw new TemplateError("Template revision conflict or unknown template; read before removing");
    return { removed: true };
  }

  async render(input: unknown): Promise<TemplateRenderResult> {
    keys(input, ["id", "expectedRevision", "values"]);
    id(input.id);
    revision(input.expectedRevision);
    if (!record(input.values)) throw new TemplateError("Template values must be an object of strings");
    const template = await this.read({ id: input.id });
    if (input.expectedRevision !== template.revision)
      throw new TemplateError("Template revision conflict; read before rendering");
    try {
      const rendered = materializeTemplate(template.body, template.parameters, input.values);
      const issue = rendered.issues[0];
      if (issue) throw new TemplateError(issue.message);
      return { source: rendered.source };
    } catch (error) {
      if (error instanceof TemplateDefinitionError) throw new TemplateError(error.message);
      throw error;
    }
  }
}
