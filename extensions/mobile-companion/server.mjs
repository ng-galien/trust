import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { renderPost, validateTemplate } from "./post-template.mjs";
import { createPostgresDatabase, postgresOptions } from "./postgres-db.mjs";
import { createPushDispatcher, preparePushKeys, pushConfiguration } from "./push.mjs";

class InputError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const object = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InputError(400, "Expected an object.");
  return value;
};
function only(value, allowed) {
  const data = object(value);
  if (Object.keys(data).some((key) => !allowed.includes(key))) throw new InputError(400, "Unknown field.");
  return data;
}
function string(value, name, maximum = 4000, required = true) {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || value.length > maximum || (required && !value.trim()))
    throw new InputError(400, `Invalid ${name}.`);
  return value.trim();
}
function identifier(value, name) {
  const result = string(value, name, 120);
  if (!/^[a-z0-9][a-z0-9._:-]*$/.test(result)) throw new InputError(400, `Invalid ${name}.`);
  return result;
}
const canonicalJson = (value) =>
  JSON.stringify(value, (_key, part) =>
    part && typeof part === "object" && !Array.isArray(part)
      ? Object.fromEntries(Object.entries(part).sort(([left], [right]) => left.localeCompare(right)))
      : part,
  );
const templateView = (row) => ({
  id: row.id,
  version: row.version,
  title: row.title,
  source: row.source,
  dataSchema: row.data_schema,
  createdAt: iso(row.created_at),
});
function route(value, name) {
  if (value === undefined) return null;
  const result = string(value, name, 2048);
  if (
    !result.startsWith("/mobile/") ||
    result.startsWith("//") ||
    result.includes("\\") ||
    [...result].some((character) => character.charCodeAt(0) < 32) ||
    result.split(/[/?#]/).some((part) => part === ".." || /%2e/i.test(part))
  )
    throw new InputError(400, `Invalid ${name}.`);
  return result;
}
function uiLayout(value, ids) {
  if (value === undefined) return null;
  const controls = [];
  function visit(raw) {
    const element = only(raw, ["type", "label", "scope", "elements", "options"]);
    if (element.type === "Control") {
      const scope = string(element.scope, "control scope", 180);
      const id = scope.startsWith("#/properties/") ? scope.slice(13) : "";
      if (!ids.has(id) || !/^[a-z0-9][a-z0-9._:-]*$/.test(id)) throw new InputError(400, "Unknown form control scope.");
      if (element.label !== undefined || element.elements !== undefined || element.options !== undefined)
        throw new InputError(400, "Unsupported control property.");
      controls.push(id);
      return { type: "Control", scope };
    }
    if (
      !["VerticalLayout", "HorizontalLayout", "Group"].includes(element.type) ||
      !Array.isArray(element.elements) ||
      element.elements.length < 1 ||
      element.elements.length > 12 ||
      element.scope !== undefined ||
      element.options !== undefined
    )
      throw new InputError(400, "Unsupported UI schema element.");
    const label = element.label === undefined ? undefined : string(element.label, "layout label", 160);
    return { type: element.type, ...(label ? { label } : {}), elements: element.elements.map(visit) };
  }
  const layout = visit(value);
  if (controls.length !== ids.size || new Set(controls).size !== ids.size)
    throw new InputError(400, "UI schema must render every field exactly once.");
  return layout;
}
function formDefinition(value) {
  if (value === undefined) return null;
  const form = only(value, ["schema", "uiSchema"]);
  const schema = only(form.schema, ["type", "properties", "required", "additionalProperties"]);
  if (
    schema.type !== "object" ||
    schema.additionalProperties !== false ||
    !schema.properties ||
    !Array.isArray(schema.required)
  )
    throw new InputError(400, "Unsupported form schema.");
  const properties = object(schema.properties);
  const ids = Object.keys(properties);
  if (
    ids.length < 1 ||
    ids.length > 12 ||
    new Set(schema.required).size !== schema.required.length ||
    schema.required.some((id) => !ids.includes(id))
  )
    throw new InputError(400, "Invalid form fields.");
  const fields = ids.map((id, position) => {
    identifier(id, "field id");
    const property = only(properties[id], ["type", "title", "enum", "format", "maxLength", "minimum", "maximum"]);
    const label = string(property.title, "field title", 160);
    const type =
      property.type === "boolean"
        ? "boolean"
        : property.type === "number"
          ? "number"
          : property.type === "string"
            ? property.enum
              ? "choice"
              : property.format === "textarea"
                ? "multiline"
                : "text"
            : null;
    if (
      !type ||
      (property.format !== undefined && property.format !== "textarea") ||
      (property.format === "textarea" && type !== "multiline") ||
      (property.maxLength !== undefined && (property.maxLength !== 8000 || !["text", "multiline"].includes(type)))
    )
      throw new InputError(400, "Unsupported field schema.");
    if ((property.minimum !== undefined || property.maximum !== undefined) && type !== "number")
      throw new InputError(400, "Numeric bounds require a number field.");
    if (
      [property.minimum, property.maximum].some(
        (bound) => bound !== undefined && (typeof bound !== "number" || !Number.isFinite(bound)),
      ) ||
      (property.minimum !== undefined && property.maximum !== undefined && property.minimum > property.maximum)
    )
      throw new InputError(400, "Invalid numeric bounds.");
    let options;
    if (type === "choice") {
      if (!Array.isArray(property.enum) || property.enum.length < 2 || property.enum.length > 20)
        throw new InputError(400, "Choice needs 2 to 20 options.");
      options = property.enum.map((option) => string(option, "choice option", 160));
      if (new Set(options).size !== options.length) throw new InputError(400, "Duplicate choice option.");
    } else if (property.enum !== undefined) throw new InputError(400, "Invalid enum.");
    return {
      id,
      position,
      label,
      type,
      required: schema.required.includes(id),
      options,
      minimum: property.minimum,
      maximum: property.maximum,
    };
  });
  const layout = uiLayout(form.uiSchema, new Set(ids));
  return { fields, uiSchema: layout };
}
function validatedAnswers(value, fields) {
  const answers = object(value);
  const byId = new Map(fields.map((field) => [field.id, field]));
  if (Object.keys(answers).some((key) => !byId.has(key))) throw new InputError(400, "Unknown answer field.");
  const result = {};
  for (const field of fields) {
    const answer = answers[field.id];
    if (answer === undefined || answer === "") {
      if (field.required) throw new InputError(400, `Answer required: ${field.label}.`);
      continue;
    }
    if (field.type === "boolean") {
      if (typeof answer !== "boolean") throw new InputError(400, `Invalid answer: ${field.label}.`);
    } else if (field.type === "number") {
      if (
        typeof answer !== "number" ||
        !Number.isFinite(answer) ||
        (field.minimum !== undefined && answer < field.minimum) ||
        (field.maximum !== undefined && answer > field.maximum)
      )
        throw new InputError(400, `Invalid answer: ${field.label}.`);
    } else if (
      typeof answer !== "string" ||
      answer.length > (field.type === "choice" ? 160 : 8000) ||
      (field.type === "choice" && !field.options.includes(answer))
    )
      throw new InputError(400, `Invalid answer: ${field.label}.`);
    result[field.id] = answer;
  }
  return result;
}
function result(status, body) {
  return { status, body, text: JSON.stringify(body) };
}
const iso = (value) => new Date(value).toISOString();
function projectView(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    route: row.route,
    updatedAt: iso(row.updated_at),
  };
}
function conversationView(project, row) {
  return {
    project,
    pinned: row?.pinned ?? false,
    deletedAt: row?.deleted_at ? iso(row.deleted_at) : null,
  };
}
async function conversationState(db, project) {
  const row = (
    await db.query(
      `SELECT c.pinned,c.deleted_at FROM trust_mobile_companion.projects p
     LEFT JOIN trust_mobile_companion.conversations c ON c.project=p.id WHERE p.id=$1`,
      [project],
    )
  ).rows[0];
  if (!row) throw new InputError(404, "Project not found.");
  return conversationView(project, row);
}
async function getForm(db, item) {
  const form = (await db.query("SELECT revision,ui_schema FROM trust_mobile_companion.forms WHERE item=$1", [item]))
    .rows[0];
  if (!form) return null;
  const fields = (
    await db.query(
      `SELECT field_id,position,label,field_type,required,minimum,maximum
    FROM trust_mobile_companion.form_fields WHERE item=$1 ORDER BY position`,
      [item],
    )
  ).rows;
  const options = (
    await db.query(
      `SELECT field_id,value FROM trust_mobile_companion.form_options
    WHERE item=$1 ORDER BY field_id,position`,
      [item],
    )
  ).rows;
  const normalized = fields.map((row) => ({
    id: row.field_id,
    label: row.label,
    type: row.field_type,
    required: row.required,
    options:
      row.field_type === "choice"
        ? options.filter((option) => option.field_id === row.field_id).map((option) => option.value)
        : undefined,
    minimum: row.minimum === null ? undefined : Number(row.minimum),
    maximum: row.maximum === null ? undefined : Number(row.maximum),
  }));
  const properties = Object.fromEntries(
    normalized.map((field) => [
      field.id,
      {
        type: field.type === "boolean" ? "boolean" : field.type === "number" ? "number" : "string",
        title: field.label,
        ...(field.type === "choice" ? { enum: field.options } : {}),
        ...(field.type === "multiline" ? { format: "textarea", maxLength: 8000 } : {}),
        ...(field.type === "text" ? { maxLength: 8000 } : {}),
        ...(field.type === "number" && field.minimum !== undefined ? { minimum: field.minimum } : {}),
        ...(field.type === "number" && field.maximum !== undefined ? { maximum: field.maximum } : {}),
      },
    ]),
  );
  return {
    revision: form.revision,
    schema: {
      type: "object",
      properties,
      required: normalized.filter((field) => field.required).map((field) => field.id),
      additionalProperties: false,
    },
    uiSchema: form.ui_schema,
    fields: normalized,
  };
}
async function getResponse(db, item) {
  const response = (
    await db.query(
      `SELECT revision,submitted_at FROM trust_mobile_companion.responses
    WHERE item=$1`,
      [item],
    )
  ).rows[0];
  if (!response) return null;
  const values = (
    await db.query(
      `SELECT field_id,text_value,bool_value,choice_value,number_value
    FROM trust_mobile_companion.response_values WHERE item=$1`,
      [item],
    )
  ).rows;
  return {
    item,
    formRevision: 1,
    responseRevision: response.revision,
    submittedAt: iso(response.submitted_at),
    answers: Object.fromEntries(
      values.map((value) => [
        value.field_id,
        value.bool_value ??
          (value.number_value === null ? null : Number(value.number_value)) ??
          value.choice_value ??
          value.text_value,
      ]),
    ),
  };
}
async function getItem(db, id, requestedVersion = null) {
  const alias = (
    await db.query("SELECT article_id FROM trust_mobile_companion.article_aliases WHERE alias_id=$1", [id])
  ).rows[0];
  const articleId = alias?.article_id ?? id;
  const row = (await db.query("SELECT * FROM trust_mobile_companion.items WHERE id=$1", [articleId])).rows[0];
  if (!row) throw new InputError(404, "Item not found.");
  const versions =
    row.kind === "explanation"
      ? (
          await db.query(
            `SELECT * FROM trust_mobile_companion.article_versions
     WHERE article_id=$1 ORDER BY version DESC LIMIT 100`,
            [articleId],
          )
        ).rows
      : [];
  const version =
    requestedVersion === null ? versions[0] : versions.find((entry) => entry.version === requestedVersion);
  if (requestedVersion !== null && !version) throw new InputError(404, "Article version not found.");
  const successor = (
    await db.query("SELECT id FROM trust_mobile_companion.items WHERE supersedes=$1 LIMIT 1", [articleId])
  ).rows[0];
  return {
    id: row.id,
    project: row.project,
    kind: row.kind,
    title: version?.title ?? row.title,
    summary: version?.summary ?? row.summary,
    body: version ? (version.raw_markdown ?? version.rendered_markdown) : (row.body ?? row.rendered_markdown),
    source:
      (version ? version.raw_markdown : row.body) !== null
        ? { mode: "raw" }
        : {
            mode: "template",
            templateId: version?.template_id ?? row.template_id,
            templateVersion: version?.template_version ?? row.template_version,
            data: version?.data ?? row.data,
            renderedSha256: version?.rendered_sha256 ?? row.rendered_sha256,
            renderer: version?.renderer ?? row.renderer,
          },
    supersedes: row.supersedes,
    currentRevision: successor?.id ?? null,
    article: version
      ? {
          id: articleId,
          version: version.version,
          latestVersion: versions[0].version,
          history: versions.map((entry) => ({
            version: entry.version,
            title: entry.title,
            author: entry.author,
            reason: entry.reason,
            publishedAt: iso(entry.published_at),
          })),
        }
      : null,
    documentUrl: row.document_url,
    plan: row.plan,
    createdAt: iso(version?.published_at ?? row.created_at),
    form: await getForm(db, id),
    response: await getResponse(db, id),
  };
}
async function verifySchema(db) {
  const version = (await db.query(`SELECT version FROM trust_mobile_companion.schema_version`)).rows;
  if (version.length !== 1 || version[0].version !== 5)
    throw new Error("Mobile companion schema requires explicit preparation.");
  const triggers = (
    await db.query(`SELECT tgname FROM pg_trigger
    WHERE tgrelid IN (
      'trust_mobile_companion.projects'::regclass,
      'trust_mobile_companion.conversations'::regclass,
      'trust_mobile_companion.subjects'::regclass,
      'trust_mobile_companion.subject_links'::regclass,
      'trust_mobile_companion.items'::regclass,
      'trust_mobile_companion.forms'::regclass,
      'trust_mobile_companion.form_fields'::regclass,
      'trust_mobile_companion.form_options'::regclass,
      'trust_mobile_companion.responses'::regclass,
      'trust_mobile_companion.response_values'::regclass,
      'trust_mobile_companion.article_versions'::regclass,
      'trust_mobile_companion.article_aliases'::regclass
    ) AND NOT tgisinternal AND tgname IN (
      'projects_changed','conversations_changed','items_changed','forms_changed','form_fields_changed',
      'form_options_changed','responses_changed','response_values_changed',
      'article_versions_changed','article_aliases_changed','subjects_changed','subject_links_changed'
    )`)
  ).rows;
  if (triggers.length !== 12) throw new Error("Mobile companion feed notifications require explicit preparation.");
  for (const query of [
    "SELECT id,public_key,private_key FROM trust_mobile_companion.push_keys LIMIT 0",
    "SELECT endpoint,active,created_at FROM trust_mobile_companion.push_subscriptions LIMIT 0",
    "SELECT item,endpoint,state,attempts,next_attempt_at,last_status FROM trust_mobile_companion.push_deliveries LIMIT 0",
    "SELECT id,title,description,status,route,updated_at FROM trust_mobile_companion.projects LIMIT 0",
    "SELECT project,pinned,deleted_at,updated_at FROM trust_mobile_companion.conversations LIMIT 0",
    "SELECT id,project,title,description,revision,updated_at FROM trust_mobile_companion.subjects LIMIT 0",
    "SELECT subject,id,position,kind,relation,description,item,target_identity,provenance FROM trust_mobile_companion.subject_links LIMIT 0",
    "SELECT id,version,title,source,data_schema,created_at FROM trust_mobile_companion.post_templates LIMIT 0",
    "SELECT article_id,version,title,summary,raw_markdown,author,reason,source_item,published_at FROM trust_mobile_companion.article_versions LIMIT 0",
    "SELECT alias_id,article_id,imported_version FROM trust_mobile_companion.article_aliases LIMIT 0",
    "SELECT id,project,kind,title,summary,body,template_id,template_version,data,rendered_markdown,rendered_sha256,renderer,supersedes,document_url,plan,created_at FROM trust_mobile_companion.items LIMIT 0",
    "SELECT item,revision,ui_schema FROM trust_mobile_companion.forms LIMIT 0",
    "SELECT item,field_id,position,label,field_type,required,minimum,maximum FROM trust_mobile_companion.form_fields LIMIT 0",
    "SELECT item,field_id,value,position FROM trust_mobile_companion.form_options LIMIT 0",
    "SELECT item,revision,submitted_at FROM trust_mobile_companion.responses LIMIT 0",
    "SELECT item,field_id,text_value,bool_value,choice_value,number_value FROM trust_mobile_companion.response_values LIMIT 0",
  ])
    await db.query(query);
  if ((await db.query("SELECT 1 FROM trust_mobile_companion.push_keys WHERE id=1")).rows.length !== 1)
    throw new Error("Mobile companion requires prepared push keys.");
}
async function feed(db, args) {
  const input = only(args, ["project", "limit", "before"]);
  const project = input.project === undefined ? null : identifier(input.project, "project");
  const limit = input.limit === undefined ? 50 : Number(input.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new InputError(400, "Invalid limit.");
  let before = null;
  if (input.before !== undefined) {
    before = (
      await db.query(
        `SELECT COALESCE(av.published_at,i.created_at) AS created_at,i.id
        FROM trust_mobile_companion.items i
        LEFT JOIN LATERAL (SELECT published_at FROM trust_mobile_companion.article_versions
          WHERE article_id=i.id ORDER BY version DESC LIMIT 1) av ON true
        WHERE i.id=$1`,
        [identifier(input.before, "cursor")],
      )
    ).rows[0];
    if (!before) throw new InputError(400, "Unknown cursor.");
  }
  const { rows } = await db.query(
    `SELECT i.id,i.project,i.kind,COALESCE(av.title,i.title) AS title,
    COALESCE(av.summary,i.summary) AS summary,i.supersedes,i.document_url,i.plan,
    COALESCE(av.published_at,i.created_at) AS created_at,
    r.submitted_at,f.item AS form_item FROM trust_mobile_companion.items i
    LEFT JOIN LATERAL (SELECT title,summary,published_at FROM trust_mobile_companion.article_versions
      WHERE article_id=i.id ORDER BY version DESC LIMIT 1) av ON true
    LEFT JOIN trust_mobile_companion.responses r ON r.item=i.id
    LEFT JOIN trust_mobile_companion.forms f ON f.item=i.id
    WHERE ($1::text IS NULL OR i.project=$1)
      AND NOT EXISTS (SELECT 1 FROM trust_mobile_companion.article_aliases a WHERE a.alias_id=i.id)
      AND ($2::timestamptz IS NULL OR (COALESCE(av.published_at,i.created_at),i.id) < ($2,$3::text))
    ORDER BY COALESCE(av.published_at,i.created_at) DESC,i.id DESC LIMIT $4`,
    [project, before?.created_at ?? null, before?.id ?? null, limit + 1],
  );
  const visible = rows.slice(0, limit);
  return {
    items: visible.map((row) => ({
      id: row.id,
      project: row.project,
      kind: row.kind,
      title: row.title,
      summary: row.summary,
      supersedes: row.supersedes,
      documentUrl: row.document_url,
      plan: row.plan,
      createdAt: iso(row.created_at),
      hasForm: row.form_item !== null,
      answered: row.submitted_at !== null,
    })),
    nextCursor: rows.length > limit ? visible.at(-1).id : null,
  };
}
async function subjectView(db, id) {
  const subject = (await db.query("SELECT * FROM trust_mobile_companion.subjects WHERE id=$1", [id])).rows[0];
  if (!subject) throw new InputError(404, "Subject not found.");
  const links = (
    await db.query("SELECT * FROM trust_mobile_companion.subject_links WHERE subject=$1 ORDER BY position", [id])
  ).rows;
  return {
    id: subject.id,
    project: subject.project,
    title: subject.title,
    description: subject.description,
    revision: subject.revision,
    updatedAt: iso(subject.updated_at),
    links: links.map((link) => ({
      id: link.id,
      kind: link.kind,
      relation: link.relation,
      description: link.description,
      item: link.item,
      targetIdentity: link.target_identity,
      provenance: link.provenance,
    })),
  };
}

async function assertSubjectTarget(db, project, link) {
  const row = (
    await db.query(
      `SELECT i.project,i.kind,i.document_url,i.plan,
      EXISTS(SELECT 1 FROM trust_mobile_companion.article_versions av WHERE av.article_id=i.id) AS article,
      EXISTS(SELECT 1 FROM trust_mobile_companion.responses r WHERE r.item=i.id) AS answered
     FROM trust_mobile_companion.items i WHERE i.id=$1`,
      [link.item],
    )
  ).rows[0];
  if (!row || row.project !== project)
    throw new InputError(400, "Subject link item must exist in the subject project.");
  const valid =
    link.kind === "article"
      ? row.kind === "explanation" && row.article && link.targetIdentity === link.item
      : link.kind === "document"
        ? row.kind === "document" && row.document_url === link.targetIdentity
        : link.kind === "plan"
          ? row.plan === link.targetIdentity
          : row.kind === "decision" && row.answered && link.targetIdentity === link.item;
  if (!valid) throw new InputError(400, "Subject link target identity does not match its source.");
}

/** @type {import('@trust/extension-sdk').ExtensionFactory} */
export function createExtension({ configuration, publishChanged }) {
  const directory = configuration.databasePath;
  const databaseUrl = configuration.databaseUrl;
  if (Boolean(directory) === Boolean(databaseUrl))
    throw new Error("Configure exactly one of databasePath or databaseUrl.");
  if (directory && !path.isAbsolute(directory)) throw new Error("databasePath must be an absolute directory.");
  if (databaseUrl) postgresOptions(databaseUrl);
  pushConfiguration(configuration);
  let db;
  let push;
  let unlisten;
  const diagnostics = [];
  function running() {
    if (!db) throw new InputError(503, "Mobile companion is stopped.");
    return db;
  }
  async function execute(envelope) {
    const input = only(envelope, ["command", "arguments"]);
    const args = object(input.arguments);
    const database = running();
    switch (input.command) {
      case "articles.read": {
        const value = only(args, ["item", "version"]);
        const id = identifier(value.item, "article");
        if (value.version !== undefined && (!Number.isInteger(value.version) || value.version < 1))
          throw new InputError(400, "Invalid article version.");
        const article = await getItem(database, id, value.version ?? null);
        if (!article.article) throw new InputError(404, "Article not found.");
        return result(200, article);
      }
      case "articles.revise": {
        const value = only(args, [
          "item",
          "expectedVersion",
          "title",
          "summary",
          "body",
          "templateId",
          "templateVersion",
          "data",
          "author",
          "reason",
        ]);
        const id = identifier(value.item, "article");
        const title = string(value.title, "article title", 200);
        const summary = string(value.summary, "article summary", 500);
        const author = string(value.author, "article author", 160);
        const reason = string(value.reason, "revision reason", 500);
        if (!Number.isInteger(value.expectedVersion) || value.expectedVersion < 1)
          throw new InputError(400, "Invalid expected article version.");
        const raw = value.body !== undefined;
        const templated =
          value.templateId !== undefined || value.templateVersion !== undefined || value.data !== undefined;
        if (raw === templated) throw new InputError(400, "Article revision needs exactly one source mode.");
        let source;
        if (raw)
          source = {
            body: string(value.body, "article body", 16000),
            templateId: null,
            templateVersion: null,
            data: null,
            rendered: null,
          };
        else {
          const templateId = identifier(value.templateId, "template id");
          if (!Number.isInteger(value.templateVersion) || value.templateVersion < 1)
            throw new InputError(400, "Invalid template version.");
          const data = object(value.data);
          const template = (
            await database.query(
              "SELECT source,data_schema FROM trust_mobile_companion.post_templates WHERE id=$1 AND version=$2",
              [templateId, value.templateVersion],
            )
          ).rows[0];
          if (!template) throw new InputError(404, "Template version not found.");
          let rendered;
          try {
            rendered = await renderPost(template.source, template.data_schema, data);
          } catch (error) {
            throw new InputError(400, error.message);
          }
          source = { body: null, templateId, templateVersion: value.templateVersion, data, rendered };
        }
        await database.transaction(async (tx) => {
          const row = (await tx.query("SELECT kind FROM trust_mobile_companion.items WHERE id=$1", [id])).rows[0];
          if (!row || row.kind !== "explanation") throw new InputError(404, "Article not found.");
          const current = (
            await tx.query(
              "SELECT max(version)::integer AS version FROM trust_mobile_companion.article_versions WHERE article_id=$1",
              [id],
            )
          ).rows[0].version;
          if (current !== value.expectedVersion) throw new InputError(409, "Article version conflict.");
          await tx.query(
            `INSERT INTO trust_mobile_companion.article_versions
             (article_id,version,title,summary,raw_markdown,template_id,template_version,data,
              rendered_markdown,rendered_sha256,renderer,author,reason)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13)`,
            [
              id,
              current + 1,
              title,
              summary,
              source.body,
              source.templateId,
              source.templateVersion,
              source.data === null ? null : JSON.stringify(source.data),
              source.rendered?.markdown ?? null,
              source.rendered?.sha256 ?? null,
              source.rendered?.renderer ?? null,
              author,
              reason,
            ],
          );
        });
        return result(201, await getItem(database, id));
      }
      case "articles.consolidate": {
        const value = only(args, ["article", "aliases"]);
        const article = identifier(value.article, "article");
        if (
          !Array.isArray(value.aliases) ||
          value.aliases.length < 1 ||
          value.aliases.length > 20 ||
          new Set(value.aliases).size !== value.aliases.length
        )
          throw new InputError(400, "Invalid article aliases.");
        const aliases = value.aliases.map((entry) => identifier(entry, "article alias"));
        await database.transaction(async (tx) => {
          const canonical = (
            await tx.query("SELECT project,kind FROM trust_mobile_companion.items WHERE id=$1", [article])
          ).rows[0];
          if (!canonical || canonical.kind !== "explanation") throw new InputError(404, "Article not found.");
          const count = (
            await tx.query(
              "SELECT max(version)::integer AS version FROM trust_mobile_companion.article_versions WHERE article_id=$1",
              [article],
            )
          ).rows[0].version;
          if (count !== 1) throw new InputError(409, "Article already has revisions.");
          for (const [offset, alias] of aliases.entries()) {
            const row = (await tx.query("SELECT * FROM trust_mobile_companion.items WHERE id=$1", [alias])).rows[0];
            if (!row || row.kind !== "explanation" || row.project !== canonical.project || alias === article)
              throw new InputError(400, "Alias must be another article in the same project.");
            if (
              (await tx.query("SELECT 1 FROM trust_mobile_companion.article_aliases WHERE alias_id=$1", [alias])).rows
                .length
            )
              throw new InputError(409, "Article is already an alias.");
            await tx.query(
              `INSERT INTO trust_mobile_companion.article_versions
               (article_id,version,title,summary,raw_markdown,template_id,template_version,data,
                rendered_markdown,rendered_sha256,renderer,author,reason,source_item,published_at)
               VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,'unknown','Imported from an existing published article',$12,$13)`,
              [
                article,
                offset + 2,
                row.title,
                row.summary,
                row.body,
                row.template_id,
                row.template_version,
                row.data === null ? null : JSON.stringify(row.data),
                row.rendered_markdown,
                row.rendered_sha256,
                row.renderer,
                alias,
                row.created_at,
              ],
            );
            await tx.query(
              "INSERT INTO trust_mobile_companion.article_aliases(alias_id,article_id,imported_version) VALUES($1,$2,$3)",
              [alias, article, offset + 2],
            );
          }
        });
        return result(201, await getItem(database, article));
      }
      case "templates.put": {
        const value = only(args, ["id", "version", "title", "source", "dataSchema"]);
        const template = {
          id: identifier(value.id, "template id"),
          version: value.version,
          title: string(value.title, "template title", 160),
          source: string(value.source, "template source", 16000),
          dataSchema: object(value.dataSchema),
        };
        if (!Number.isInteger(template.version) || template.version < 1 || template.version > 1000000)
          throw new InputError(400, "Invalid template version.");
        try {
          validateTemplate(template.source, template.dataSchema);
        } catch (error) {
          throw new InputError(400, error.message);
        }
        const write = await database.query(
          `INSERT INTO trust_mobile_companion.post_templates(id,version,title,source,data_schema)
           VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(id,version) DO NOTHING RETURNING *`,
          [template.id, template.version, template.title, template.source, JSON.stringify(template.dataSchema)],
        );
        const row =
          write.rows[0] ??
          (
            await database.query("SELECT * FROM trust_mobile_companion.post_templates WHERE id=$1 AND version=$2", [
              template.id,
              template.version,
            ])
          ).rows[0];
        if (
          !write.rows.length &&
          (row.title !== template.title ||
            row.source !== template.source ||
            canonicalJson(row.data_schema) !== canonicalJson(template.dataSchema))
        )
          throw new InputError(409, "Template version already contains different content.");
        return result(write.rows.length ? 201 : 200, templateView(row));
      }
      case "templates.read": {
        const value = only(args, ["id", "version"]);
        const id = identifier(value.id, "template id");
        if (!Number.isInteger(value.version)) throw new InputError(400, "Invalid template version.");
        const row = (
          await database.query("SELECT * FROM trust_mobile_companion.post_templates WHERE id=$1 AND version=$2", [
            id,
            value.version,
          ])
        ).rows[0];
        if (!row) throw new InputError(404, "Template version not found.");
        return result(200, templateView(row));
      }
      case "templates.list": {
        only(args, []);
        const rows = (
          await database.query(
            "SELECT id,version,title,created_at FROM trust_mobile_companion.post_templates ORDER BY id,version DESC LIMIT 100",
          )
        ).rows;
        return result(200, {
          templates: rows.map((row) => ({
            id: row.id,
            version: row.version,
            title: row.title,
            createdAt: iso(row.created_at),
          })),
        });
      }
      case "posts.read": {
        const value = only(args, ["item"]);
        return result(200, await getItem(database, identifier(value.item, "item")));
      }
      case "posts.publish": {
        const value = only(args, [
          "id",
          "project",
          "kind",
          "title",
          "summary",
          "templateId",
          "templateVersion",
          "data",
          "supersedes",
          "plan",
        ]);
        const item = {
          id: identifier(value.id, "item id"),
          project: identifier(value.project, "project"),
          kind: value.kind,
          title: string(value.title, "item title", 200),
          summary: string(value.summary, "item summary", 500),
          templateId: identifier(value.templateId, "template id"),
          templateVersion: value.templateVersion,
          data: object(value.data),
          supersedes: value.supersedes === undefined ? null : identifier(value.supersedes, "superseded item"),
          plan: value.plan === undefined ? null : string(value.plan, "Plan", 200),
        };
        if (
          !["progress", "explanation"].includes(item.kind) ||
          !Number.isInteger(item.templateVersion) ||
          item.templateVersion < 1
        )
          throw new InputError(400, "Invalid templated post kind or version.");
        const template = (
          await database.query(
            "SELECT source,data_schema FROM trust_mobile_companion.post_templates WHERE id=$1 AND version=$2",
            [item.templateId, item.templateVersion],
          )
        ).rows[0];
        if (!template) throw new InputError(404, "Template version not found.");
        let rendered;
        try {
          rendered = await renderPost(template.source, template.data_schema, item.data);
        } catch (error) {
          throw new InputError(400, error.message);
        }
        const write = await database.transaction(async (tx) => {
          const inserted = await tx.query(
            `INSERT INTO trust_mobile_companion.items
              (id,project,kind,title,summary,body,template_id,template_version,data,rendered_markdown,
               rendered_sha256,renderer,supersedes,plan)
             VALUES($1,$2,$3,$4,$5,NULL,$6,$7,$8::jsonb,$9,$10,$11,$12,$13)
             ON CONFLICT(id) DO NOTHING RETURNING id`,
            [
              item.id,
              item.project,
              item.kind,
              item.title,
              item.summary,
              item.templateId,
              item.templateVersion,
              JSON.stringify(item.data),
              rendered.markdown,
              rendered.sha256,
              rendered.renderer,
              item.supersedes,
              item.plan,
            ],
          );
          if (inserted.rows.length)
            await tx.query(
              `INSERT INTO trust_mobile_companion.push_deliveries(item,endpoint)
             SELECT $1,endpoint FROM trust_mobile_companion.push_subscriptions WHERE active`,
              [item.id],
            );
          if (inserted.rows.length && item.kind === "explanation")
            await tx.query(
              `INSERT INTO trust_mobile_companion.article_versions
             (article_id,version,title,summary,template_id,template_version,data,
              rendered_markdown,rendered_sha256,renderer,author,reason,source_item,published_at)
             SELECT id,1,title,summary,template_id,template_version,data,
              rendered_markdown,rendered_sha256,renderer,'unspecified','Initial publication',id,created_at
             FROM trust_mobile_companion.items WHERE id=$1`,
              [item.id],
            );
          return inserted.rows.length > 0;
        });
        const stored = await getItem(database, item.id);
        if (
          !write &&
          (stored.source.mode !== "template" ||
            stored.project !== item.project ||
            stored.kind !== item.kind ||
            stored.title !== item.title ||
            stored.summary !== item.summary ||
            stored.plan !== item.plan ||
            stored.supersedes !== item.supersedes ||
            stored.source.templateId !== item.templateId ||
            stored.source.templateVersion !== item.templateVersion ||
            canonicalJson(stored.source.data) !== canonicalJson(item.data) ||
            stored.body !== rendered.markdown)
        )
          throw new InputError(409, "Item identifier already contains different content.");
        if (write) push?.kick();
        return result(write ? 201 : 200, stored);
      }
      case "projects.list": {
        only(args, []);
        return result(200, {
          projects: (await database.query("SELECT * FROM trust_mobile_companion.projects ORDER BY title,id")).rows.map(
            projectView,
          ),
        });
      }
      case "projects.put": {
        const value = only(args, ["id", "title", "description", "status", "route"]);
        const project = {
          id: identifier(value.id, "project id"),
          title: string(value.title, "project title", 160),
          description: string(value.description ?? "", "project description", 1000, false),
          status: value.status,
          route: route(value.route, "project route"),
        };
        if (!["active", "paused", "unavailable"].includes(project.status))
          throw new InputError(400, "Invalid project status.");
        const { rows } = await database.query(
          `INSERT INTO trust_mobile_companion.projects
          (id,title,description,status,route) VALUES($1,$2,$3,$4,$5)
          ON CONFLICT(id) DO UPDATE SET title=excluded.title,description=excluded.description,
          status=excluded.status,route=excluded.route,updated_at=now() RETURNING *`,
          [project.id, project.title, project.description, project.status, project.route],
        );
        return result(200, projectView(rows[0]));
      }
      case "subjects.list": {
        const value = only(args, ["project"]);
        const project = identifier(value.project, "project");
        const rows = (
          await database.query(
            "SELECT id FROM trust_mobile_companion.subjects WHERE project=$1 ORDER BY updated_at DESC,id",
            [project],
          )
        ).rows;
        return result(200, { subjects: await Promise.all(rows.map((row) => subjectView(database, row.id))) });
      }
      case "subjects.read": {
        const value = only(args, ["id"]);
        return result(200, await subjectView(database, identifier(value.id, "subject")));
      }
      case "subjects.put": {
        const value = only(args, ["id", "project", "title", "description", "expectedRevision", "links"]);
        const subject = {
          id: identifier(value.id, "subject"),
          project: identifier(value.project, "project"),
          title: string(value.title, "subject title", 160),
          description: string(value.description, "subject description", 1000),
        };
        if (!Number.isInteger(value.expectedRevision) || value.expectedRevision < 0)
          throw new InputError(400, "Invalid expected subject revision.");
        if (!Array.isArray(value.links) || value.links.length > 50)
          throw new InputError(400, "Subject needs at most 50 links.");
        const links = value.links.map((raw) => {
          const link = only(raw, ["id", "kind", "relation", "description", "item", "targetIdentity", "provenance"]);
          if (!["article", "document", "plan", "decision"].includes(link.kind))
            throw new InputError(400, "Invalid subject link kind.");
          return {
            id: identifier(link.id, "link"),
            kind: link.kind,
            relation: string(link.relation, "relation", 160),
            description: string(link.description, "link description", 500),
            item: identifier(link.item, "linked item"),
            targetIdentity: string(link.targetIdentity, "target identity", 2048),
            provenance: string(link.provenance, "link provenance", 500),
          };
        });
        if (new Set(links.map((link) => link.id)).size !== links.length)
          throw new InputError(400, "Duplicate subject link identifier.");
        await database.transaction(async (tx) => {
          for (const link of links) await assertSubjectTarget(tx, subject.project, link);
          if (value.expectedRevision === 0) {
            const inserted = await tx.query(
              `INSERT INTO trust_mobile_companion.subjects(id,project,title,description,revision)
               VALUES($1,$2,$3,$4,1) ON CONFLICT(id) DO NOTHING RETURNING id`,
              [subject.id, subject.project, subject.title, subject.description],
            );
            if (!inserted.rows.length) throw new InputError(409, "Subject revision conflict.");
          } else {
            const updated = await tx.query(
              `UPDATE trust_mobile_companion.subjects SET title=$3,description=$4,revision=revision+1,updated_at=now()
               WHERE id=$1 AND project=$2 AND revision=$5 RETURNING id`,
              [subject.id, subject.project, subject.title, subject.description, value.expectedRevision],
            );
            if (!updated.rows.length) throw new InputError(409, "Subject revision conflict.");
            await tx.query("DELETE FROM trust_mobile_companion.subject_links WHERE subject=$1", [subject.id]);
          }
          for (const [position, link] of links.entries())
            await tx.query(
              `INSERT INTO trust_mobile_companion.subject_links
               (subject,id,position,kind,relation,description,item,target_identity,provenance)
               VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
              [
                subject.id,
                link.id,
                position,
                link.kind,
                link.relation,
                link.description,
                link.item,
                link.targetIdentity,
                link.provenance,
              ],
            );
        });
        return result(value.expectedRevision === 0 ? 201 : 200, await subjectView(database, subject.id));
      }
      case "conversations.list": {
        const value = only(args, ["includeDeleted"]);
        if (value.includeDeleted !== undefined && typeof value.includeDeleted !== "boolean")
          throw new InputError(400, "Invalid includeDeleted flag.");
        const rows = (
          await database.query(
            `SELECT p.id AS project,c.pinned,c.deleted_at FROM trust_mobile_companion.projects p
           LEFT JOIN trust_mobile_companion.conversations c ON c.project=p.id
           WHERE $1::boolean OR c.deleted_at IS NULL
           ORDER BY (c.deleted_at IS NOT NULL),COALESCE(c.pinned,false) DESC,p.title,p.id`,
            [value.includeDeleted ?? false],
          )
        ).rows;
        return result(200, { conversations: rows.map((row) => conversationView(row.project, row)) });
      }
      case "conversations.pin": {
        const value = only(args, ["project", "pinned"]);
        const project = identifier(value.project, "project");
        if (typeof value.pinned !== "boolean") throw new InputError(400, "Invalid pinned flag.");
        await database.transaction(async (tx) => {
          const current = await conversationState(tx, project);
          if (current.deletedAt) throw new InputError(409, "Deleted conversation must be restored first.");
          if (current.pinned === value.pinned) return;
          await tx.query(
            `INSERT INTO trust_mobile_companion.conversations(project,pinned)
             VALUES($1,$2) ON CONFLICT(project) DO UPDATE
             SET pinned=excluded.pinned,updated_at=now()`,
            [project, value.pinned],
          );
        });
        return result(200, await conversationState(database, project));
      }
      case "conversations.delete": {
        const value = only(args, ["project"]);
        const project = identifier(value.project, "project");
        await database.transaction(async (tx) => {
          const current = await conversationState(tx, project);
          if (current.deletedAt) return;
          await tx.query(
            `INSERT INTO trust_mobile_companion.conversations(project,deleted_at)
             VALUES($1,now()) ON CONFLICT(project) DO UPDATE
             SET deleted_at=now(),updated_at=now()`,
            [project],
          );
        });
        return result(200, await conversationState(database, project));
      }
      case "conversations.restore": {
        const value = only(args, ["project"]);
        const project = identifier(value.project, "project");
        await database.transaction(async (tx) => {
          const current = await conversationState(tx, project);
          if (!current.deletedAt) return;
          await tx.query(
            `UPDATE trust_mobile_companion.conversations
             SET deleted_at=NULL,updated_at=now() WHERE project=$1`,
            [project],
          );
        });
        return result(200, await conversationState(database, project));
      }
      case "feed.publish": {
        const value = only(args, [
          "id",
          "project",
          "kind",
          "title",
          "summary",
          "body",
          "documentUrl",
          "form",
          "plan",
          "supersedes",
        ]);
        const item = {
          id: identifier(value.id, "item id"),
          project: identifier(value.project, "project"),
          kind: value.kind,
          title: string(value.title, "item title", 200),
          summary: string(value.summary, "item summary", 500),
          body: string(value.body, "item body", 16000),
          documentUrl: route(value.documentUrl, "document URL"),
          form: formDefinition(value.form),
          plan: value.plan === undefined ? null : string(value.plan, "Plan", 200),
          supersedes: value.supersedes === undefined ? null : identifier(value.supersedes, "superseded item"),
        };
        if (
          !["progress", "explanation", "question", "decision", "confirmation", "review", "document"].includes(item.kind)
        )
          throw new InputError(400, "Invalid item kind.");
        if (item.form && !["question", "decision", "confirmation", "review"].includes(item.kind))
          throw new InputError(400, "This item kind cannot contain a form.");
        if (item.kind === "document" && !item.documentUrl) throw new InputError(400, "A document needs a URL.");
        if (item.documentUrl && item.kind !== "document")
          throw new InputError(400, "Only document items may link a document.");
        let inserted = false;
        await database.transaction(async (tx) => {
          const write = await tx.query(
            `INSERT INTO trust_mobile_companion.items
            (id,project,kind,title,summary,body,document_url,plan,supersedes)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO NOTHING RETURNING id`,
            [
              item.id,
              item.project,
              item.kind,
              item.title,
              item.summary,
              item.body,
              item.documentUrl,
              item.plan,
              item.supersedes,
            ],
          );
          inserted = write.rows.length > 0;
          if (!inserted) return;
          if (item.form) {
            await tx.query("INSERT INTO trust_mobile_companion.forms(item,ui_schema) VALUES($1,$2)", [
              item.id,
              item.form.uiSchema === null ? null : JSON.stringify(item.form.uiSchema),
            ]);
            for (const field of item.form.fields) {
              await tx.query(
                `INSERT INTO trust_mobile_companion.form_fields
                (item,field_id,position,label,field_type,required,minimum,maximum)
                VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
                [
                  item.id,
                  field.id,
                  field.position,
                  field.label,
                  field.type,
                  field.required,
                  field.minimum ?? null,
                  field.maximum ?? null,
                ],
              );
              for (const [position, option] of (field.options ?? []).entries())
                await tx.query(
                  `INSERT INTO trust_mobile_companion.form_options
                  (item,field_id,value,position) VALUES($1,$2,$3,$4)`,
                  [item.id, field.id, option, position],
                );
            }
          }
          if (item.kind === "explanation")
            await tx.query(
              `INSERT INTO trust_mobile_companion.article_versions
             (article_id,version,title,summary,raw_markdown,author,reason,source_item,published_at)
             SELECT id,1,title,summary,body,'unspecified','Initial publication',id,created_at
             FROM trust_mobile_companion.items WHERE id=$1`,
              [item.id],
            );
          await tx.query(
            `INSERT INTO trust_mobile_companion.push_deliveries(item,endpoint)
            SELECT $1,endpoint FROM trust_mobile_companion.push_subscriptions WHERE active`,
            [item.id],
          );
        });
        const stored = await getItem(database, item.id);
        const comparable = (entry) =>
          JSON.stringify([
            entry.project,
            entry.kind,
            entry.title,
            entry.summary,
            entry.body,
            entry.documentUrl,
            entry.plan,
            entry.supersedes,
          ]);
        const fieldContent = (fields) =>
          fields?.map((field) => [
            field.id,
            field.label,
            field.type,
            field.required,
            field.options ?? null,
            field.minimum ?? null,
            field.maximum ?? null,
          ]) ?? null;
        if (
          !inserted &&
          (stored.source.mode !== "raw" ||
            comparable(stored) !== comparable(item) ||
            JSON.stringify(fieldContent(stored.form?.fields)) !== JSON.stringify(fieldContent(item.form?.fields)) ||
            JSON.stringify(stored.form?.uiSchema ?? null) !== JSON.stringify(item.form?.uiSchema ?? null))
        )
          throw new InputError(409, "Item identifier already contains different content.");
        if (inserted) {
          push?.kick();
        }
        return result(inserted ? 201 : 200, stored);
      }
      case "notifications.status": {
        only(args, []);
        return result(200, await push.status());
      }
      case "notifications.subscribe": {
        const value = only(args, ["endpoint"]);
        try {
          return result(200, await push.subscribe(value.endpoint));
        } catch (error) {
          throw new InputError(400, error.message);
        }
      }
      case "notifications.unsubscribe": {
        const value = only(args, ["endpoint"]);
        try {
          return result(200, await push.unsubscribe(value.endpoint));
        } catch (error) {
          throw new InputError(400, error.message);
        }
      }
      case "client.report": {
        const value = only(args, ["stage", "code", "platform", "session"]);
        const stage = string(value.stage, "diagnostic stage", 40);
        const code = string(value.code, "diagnostic code", 40);
        const platform = string(value.platform, "diagnostic platform", 12);
        const session = string(value.session, "diagnostic session", 36);
        if (
          !["host-boot", "host-resource", "host-script", "remote-import", "react", "route"].includes(stage) ||
          ![
            "started",
            "loaded",
            "failed",
            "mounted",
            "TypeError",
            "SyntaxError",
            "ReferenceError",
            "Error",
            "unknown",
          ].includes(code) ||
          !["Android", "macOS", "Windows", "Linux", "other"].includes(platform) ||
          !/^[a-f0-9-]{8,36}$/.test(session)
        )
          throw new InputError(400, "Invalid client diagnostic.");
        diagnostics.unshift({ at: new Date().toISOString(), stage, code, platform, session });
        diagnostics.length = Math.min(diagnostics.length, 32);
        return result(202, { recorded: true });
      }
      case "diagnostics.read": {
        only(args, []);
        return result(200, { extension: "mobile-companion", state: "RUNNING", recent: diagnostics });
      }
      case "feed.list":
        return result(200, await feed(database, args));
      case "items.read": {
        const value = only(args, ["item", "version"]);
        if (value.version !== undefined && (!Number.isInteger(value.version) || value.version < 1))
          throw new InputError(400, "Invalid article version.");
        return result(200, await getItem(database, identifier(value.item, "item"), value.version ?? null));
      }
      case "responses.read": {
        const value = only(args, ["item"]);
        const id = identifier(value.item, "item");
        if (!(await getItem(database, id)).form) throw new InputError(404, "Form not found.");
        const response = await getResponse(database, id);
        if (!response) throw new InputError(404, "Response not yet submitted.");
        return result(200, response);
      }
      case "responses.submit": {
        const value = only(args, ["item", "expectedRevision", "answers"]);
        const id = identifier(value.item, "item");
        const item = await getItem(database, id);
        if (!item.form) throw new InputError(409, "Item has no response form.");
        if (value.expectedRevision !== 0) throw new InputError(409, "Response revision conflict.");
        const fields = item.form.fields;
        const answers = validatedAnswers(value.answers, fields);
        let inserted = false;
        await database.transaction(async (tx) => {
          const write = await tx.query(
            `INSERT INTO trust_mobile_companion.responses(item)
            VALUES($1) ON CONFLICT(item) DO NOTHING RETURNING item`,
            [id],
          );
          inserted = write.rows.length > 0;
          if (!inserted) return;
          for (const [fieldId, answer] of Object.entries(answers)) {
            const field = fields.find((entry) => entry.id === fieldId);
            await tx.query(
              `INSERT INTO trust_mobile_companion.response_values
              (item,field_id,text_value,bool_value,choice_value,number_value) VALUES($1,$2,$3,$4,$5,$6)`,
              [
                id,
                fieldId,
                field.type === "text" || field.type === "multiline" ? answer : null,
                field.type === "boolean" ? answer : null,
                field.type === "choice" ? answer : null,
                field.type === "number" ? answer : null,
              ],
            );
          }
        });
        const stored = await getResponse(database, id);
        if (JSON.stringify(stored.answers) !== JSON.stringify(answers))
          throw new InputError(409, "Answer already submitted.");
        return result(inserted ? 201 : 200, stored);
      }
      default:
        throw new InputError(400, "Unknown command.");
    }
  }
  return {
    async prepare() {
      if (db) throw new Error("Stop mobile companion before preparation.");
      if (databaseUrl) {
        const candidate = createPostgresDatabase(databaseUrl);
        try {
          await candidate.transaction(async (tx) => {
            await tx.query("SELECT pg_advisory_xact_lock(194017, 5)");
            const present =
              (await tx.query("SELECT 1 FROM pg_namespace WHERE nspname='trust_mobile_companion'")).rows.length > 0;
            if (!present) await tx.query(await readFile(new URL("./schema.sql", import.meta.url), "utf8"));
            await preparePushKeys(tx);
            await verifySchema(tx);
          });
        } finally {
          await candidate.close();
        }
        return;
      }
      const existed = existsSync(directory);
      await mkdir(path.dirname(directory), { recursive: true });
      const candidate = await PGlite.create(directory);
      try {
        const present =
          (await candidate.query(`SELECT 1 FROM pg_namespace WHERE nspname='trust_mobile_companion'`)).rows.length > 0;
        if (!present) {
          if (existed) throw new Error("Existing PGlite directory lacks the mobile schema; operator review required.");
          await candidate.exec(await readFile(new URL("./schema.sql", import.meta.url), "utf8"));
        }
        await preparePushKeys(candidate);
        await verifySchema(candidate);
      } finally {
        await candidate.close();
      }
    },
    async start() {
      if (db) return;
      if (directory && !existsSync(directory)) throw new Error("Explicit preparation is required.");
      const candidate = databaseUrl ? createPostgresDatabase(databaseUrl) : await PGlite.create(directory);
      try {
        await verifySchema(candidate);
        unlisten = await candidate.listen("trust_mobile_companion_feed_changed", () => publishChanged());
        push = await createPushDispatcher(candidate, configuration);
      } catch (error) {
        await unlisten?.();
        unlisten = undefined;
        await push?.close();
        push = undefined;
        await candidate.close();
        throw error;
      }
      db = candidate;
    },
    async stop() {
      const running = db;
      db = undefined;
      await unlisten?.();
      unlisten = undefined;
      if (push) await push.close();
      push = undefined;
      if (running) await running.close();
    },
    async read(input) {
      try {
        const { path: requested, query } = only(input, ["path", "query"]);
        const requestPath = string(requested, "path", 300);
        const params = object(query);
        if (requestPath === "/projects") return await execute({ command: "projects.list", arguments: params });
        if (requestPath === "/subjects") return await execute({ command: "subjects.list", arguments: params });
        if (requestPath.startsWith("/subjects/")) {
          only(params, []);
          return await execute({
            command: "subjects.read",
            arguments: { id: decodeURIComponent(requestPath.slice(10)) },
          });
        }
        if (requestPath === "/conversations") {
          only(params, ["includeDeleted"]);
          const includeDeleted =
            params.includeDeleted === undefined
              ? undefined
              : params.includeDeleted === "true"
                ? true
                : params.includeDeleted === "false"
                  ? false
                  : params.includeDeleted;
          return await execute({
            command: "conversations.list",
            arguments: includeDeleted === undefined ? {} : { includeDeleted },
          });
        }
        if (requestPath === "/feed") return await execute({ command: "feed.list", arguments: params });
        if (requestPath === "/notifications/status")
          return await execute({ command: "notifications.status", arguments: params });
        if (requestPath.startsWith("/items/")) {
          only(params, ["version"]);
          const version = params.version === undefined ? undefined : Number(params.version);
          if (version !== undefined && (!Number.isInteger(version) || version < 1))
            throw new InputError(400, "Invalid article version.");
          return await execute({
            command: "items.read",
            arguments: {
              item: decodeURIComponent(requestPath.slice(7)),
              ...(version === undefined ? {} : { version }),
            },
          });
        }
        if (requestPath.startsWith("/responses/")) {
          only(params, []);
          return await execute({
            command: "responses.read",
            arguments: { item: decodeURIComponent(requestPath.slice(11)) },
          });
        }
        throw new InputError(404, "Unknown mobile resource.");
      } catch (error) {
        if (error instanceof InputError) return result(error.status, { error: error.message });
        throw error;
      }
    },
    async command(input) {
      try {
        return await execute(input);
      } catch (error) {
        if (error instanceof InputError) return result(error.status, { error: error.message });
        if (error?.code === "23503") return result(404, { error: "Project or item not found." });
        throw error;
      }
    },
  };
}
