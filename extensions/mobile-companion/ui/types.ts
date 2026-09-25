export type Project = {
  id: string;
  title: string;
  description: string;
  status: "active" | "paused" | "unavailable";
  route: string | null;
};

export type Conversation = { project: string; pinned: boolean; deletedAt: string | null };

export type SubjectLink = {
  id: string;
  kind: "article" | "document" | "plan" | "decision";
  relation: string;
  description: string;
  item: string;
  targetIdentity: string;
  provenance: string;
};
export type Subject = {
  id: string;
  project: string;
  title: string;
  description: string;
  revision: number;
  updatedAt: string;
  links: SubjectLink[];
};

export type Summary = {
  id: string;
  project: string;
  kind: string;
  title: string;
  summary: string;
  supersedes: string | null;
  createdAt: string;
  hasForm: boolean;
  answered: boolean;
  documentUrl: string | null;
  plan: string | null;
};

export type Field = {
  id: string;
  label: string;
  type: "text" | "multiline" | "choice" | "boolean" | "number";
  required: boolean;
  options?: string[];
  minimum?: number;
  maximum?: number;
};

export type Layout =
  | { type: "Control"; scope: string }
  | { type: "VerticalLayout" | "HorizontalLayout" | "Group"; label?: string; elements: Layout[] };

export type Item = Summary & {
  body: string;
  article: {
    id: string;
    version: number;
    latestVersion: number;
    history: { version: number; title: string; author: string; reason: string; publishedAt: string }[];
  } | null;
  form: { revision: number; schema: object; uiSchema: Layout | null; fields: Field[] } | null;
  response: { answers: Record<string, string | boolean | number>; submittedAt: string } | null;
};

export type PushStatus = { enabled: boolean; publicKey: string | null; pending: number };

export type Copy = Record<string, string>;
