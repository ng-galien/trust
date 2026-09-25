import type { Conversation, Field, Item, Layout, Project, PushStatus, Subject, Summary } from "./types";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid mobile response.");
  return value as RecordValue;
};
const string = (value: unknown): string => {
  if (typeof value !== "string") throw new Error("Invalid mobile response.");
  return value;
};
const boolean = (value: unknown): boolean => {
  if (typeof value !== "boolean") throw new Error("Invalid mobile response.");
  return value;
};
const nullableString = (value: unknown): string | null => (value === null ? null : string(value));
const array = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) throw new Error("Invalid mobile response.");
  return value;
};

function project(value: unknown): Project {
  const row = record(value);
  const status = string(row.status);
  if (status !== "active" && status !== "paused" && status !== "unavailable")
    throw new Error("Invalid mobile project status.");
  return {
    id: string(row.id),
    title: string(row.title),
    description: string(row.description),
    status,
    route: nullableString(row.route),
  };
}

function summary(value: unknown): Summary {
  const row = record(value);
  return {
    id: string(row.id),
    project: string(row.project),
    kind: string(row.kind),
    title: string(row.title),
    summary: string(row.summary),
    supersedes: row.supersedes === undefined ? null : nullableString(row.supersedes),
    createdAt: string(row.createdAt),
    hasForm: boolean(row.hasForm),
    answered: boolean(row.answered),
    documentUrl: nullableString(row.documentUrl),
    plan: nullableString(row.plan),
  };
}

function field(value: unknown): Field {
  const row = record(value);
  const type = string(row.type);
  if (!["text", "multiline", "choice", "boolean", "number"].includes(type))
    throw new Error("Invalid mobile form field.");
  return {
    id: string(row.id),
    label: string(row.label),
    type: type as Field["type"],
    required: boolean(row.required),
    ...(row.options === undefined ? {} : { options: array(row.options).map(string) }),
    ...(row.minimum === undefined ? {} : { minimum: Number(row.minimum) }),
    ...(row.maximum === undefined ? {} : { maximum: Number(row.maximum) }),
  };
}

function item(value: unknown): Item {
  const row = record(value);
  const form = row.form === null ? null : record(row.form);
  const response = row.response === null ? null : record(row.response);
  const article = row.article === undefined || row.article === null ? null : record(row.article);
  const answers: Record<string, string | boolean | number> = {};
  if (response) {
    for (const [key, answer] of Object.entries(record(response.answers))) {
      if (typeof answer !== "string" && typeof answer !== "boolean" && typeof answer !== "number")
        throw new Error("Invalid mobile answer.");
      answers[key] = answer;
    }
  }
  return {
    id: string(row.id),
    project: string(row.project),
    kind: string(row.kind),
    title: string(row.title),
    summary: string(row.summary),
    supersedes: row.supersedes === undefined ? null : nullableString(row.supersedes),
    createdAt: string(row.createdAt),
    hasForm: form !== null,
    answered: response !== null,
    documentUrl: nullableString(row.documentUrl),
    plan: nullableString(row.plan),
    body: string(row.body),
    article: article
      ? {
          id: string(article.id),
          version: Number(article.version),
          latestVersion: Number(article.latestVersion),
          history: array(article.history).map((entry) => {
            const history = record(entry);
            return {
              version: Number(history.version),
              title: string(history.title),
              author: string(history.author),
              reason: string(history.reason),
              publishedAt: string(history.publishedAt),
            };
          }),
        }
      : null,
    form: form
      ? {
          revision: Number(form.revision),
          schema: record(form.schema),
          uiSchema: form.uiSchema === null ? null : (record(form.uiSchema) as Layout),
          fields: array(form.fields).map(field),
        }
      : null,
    response: response ? { answers, submittedAt: string(response.submittedAt) } : null,
  };
}

async function json(url: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(url, signal ? { signal } : undefined);
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  return response.json();
}

export async function readProjects(apiBase: string, signal?: AbortSignal): Promise<Project[]> {
  return array(record(await json(`${apiBase}/projects`, signal)).projects).map(project);
}

function subject(value: unknown): Subject {
  const row = record(value);
  return {
    id: string(row.id),
    project: string(row.project),
    title: string(row.title),
    description: string(row.description),
    revision: Number(row.revision),
    updatedAt: string(row.updatedAt),
    links: array(row.links).map((value) => {
      const link = record(value);
      const kind = string(link.kind);
      if (!["article", "document", "plan", "decision"].includes(kind)) throw new Error("Invalid subject link kind.");
      return {
        id: string(link.id),
        kind: kind as Subject["links"][number]["kind"],
        relation: string(link.relation),
        description: string(link.description),
        item: string(link.item),
        targetIdentity: string(link.targetIdentity),
        provenance: string(link.provenance),
      };
    }),
  };
}

export async function readSubjects(apiBase: string, project: string, signal?: AbortSignal): Promise<Subject[]> {
  return array(record(await json(`${apiBase}/subjects?project=${encodeURIComponent(project)}`, signal)).subjects).map(
    subject,
  );
}

export async function readSubject(apiBase: string, id: string, signal?: AbortSignal): Promise<Subject> {
  return subject(await json(`${apiBase}/subjects/${encodeURIComponent(id)}`, signal));
}

export async function readConversations(apiBase: string, signal?: AbortSignal): Promise<Conversation[]> {
  return array(record(await json(`${apiBase}/conversations`, signal)).conversations).map((value) => {
    const row = record(value);
    return { project: string(row.project), pinned: boolean(row.pinned), deletedAt: nullableString(row.deletedAt) };
  });
}

export async function readFeed(
  apiBase: string,
  query: { project?: string; before?: string; limit?: number },
  signal?: AbortSignal,
): Promise<{ items: Summary[]; nextCursor: string | null }> {
  const params = new URLSearchParams({ limit: String(query.limit ?? 50) });
  if (query.project) params.set("project", query.project);
  if (query.before) params.set("before", query.before);
  const body = record(await json(`${apiBase}/feed?${params}`, signal));
  return { items: array(body.items).map(summary), nextCursor: nullableString(body.nextCursor) };
}

export async function readItem(apiBase: string, id: string, version?: number, signal?: AbortSignal): Promise<Item> {
  const suffix = version === undefined ? "" : `?version=${version}`;
  return item(await json(`${apiBase}/items/${encodeURIComponent(id)}${suffix}`, signal));
}

export async function readPushStatus(apiBase: string): Promise<PushStatus> {
  const body = record(await json(`${apiBase}/notifications/status`));
  return { enabled: boolean(body.enabled), publicKey: nullableString(body.publicKey), pending: Number(body.pending) };
}
