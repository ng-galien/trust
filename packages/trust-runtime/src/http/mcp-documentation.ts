import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const DOCUMENTATION_TOOL_NAMES = ["trust_documentation_list", "trust_documentation_read"] as const;

interface Document {
  id: string;
  title: string;
  summary: string;
  text: string;
}

export class DocumentationArgumentsError extends Error {}

export function isDocumentationToolName(value: string): boolean {
  return DOCUMENTATION_TOOL_NAMES.some((name) => name === value);
}

let catalogPromise: Promise<Document[]> | undefined;
function catalog(): Promise<Document[]> {
  catalogPromise ??= readFile(new URL("../../documentation/catalog.json", import.meta.url), "utf8").then((source) => {
    const parsed: unknown = JSON.parse(source);
    if (!record(parsed) || parsed.format !== 1 || !Array.isArray(parsed.documents)) {
      throw new Error("Invalid documentation artifact");
    }
    const ids = new Set<string>();
    return parsed.documents.map((value: unknown) => {
      if (!record(value) || !identifier(value.id) || !text(value.title) || !text(value.summary) || !text(value.text)) {
        throw new Error("Invalid documentation entry");
      }
      if (ids.has(value.id)) throw new Error("Duplicate documentation entry");
      ids.add(value.id);
      return { id: value.id, title: value.title, summary: value.summary, text: value.text };
    });
  });
  return catalogPromise;
}

export async function callDocumentationTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError?: true }> {
  const listing = name === "trust_documentation_list";
  const allowed = listing ? ["query", "cursor", "limit"] : ["document", "cursor", "limit"];
  if (Object.keys(args).some((key) => !allowed.includes(key))) invalid();
  if (args.cursor !== undefined && (!text(args.cursor) || args.cursor.length > 1024)) invalid();
  const limit = args.limit === undefined ? (listing ? 10 : 6000) : args.limit;
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > (listing ? 25 : 12000))
    invalid();
  if (listing && args.query !== undefined && (!text(args.query) || args.query.length > 256)) invalid();
  if (!listing && !identifier(args.document)) invalid();
  let documents: Document[];
  try {
    documents = await catalog();
  } catch {
    return {
      text: "Documentation is unavailable in this installation. Rebuild or reinstall the documentation artifact.",
      isError: true,
    };
  }
  if (listing) {
    const query = typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
    const matches = documents.filter((document) =>
      `${document.id}\n${document.title}\n${document.summary}\n${document.text}`.toLowerCase().includes(query),
    );
    const digest = hash(JSON.stringify(matches));
    const scope = `list:${hash(query)}`;
    const offset = readCursor(args.cursor, scope, digest, matches.length);
    const page = matches.slice(offset, offset + limit);
    const next = offset + page.length;
    return {
      text: [
        "TRUST DOCUMENTATION",
        "Start: agents/README",
        "Read with trust_documentation_read using the exact document identifier.",
        `Matches: ${matches.length}`,
        `Complete: ${next >= matches.length ? "yes" : "no"}`,
        ...page.map((document) => `- ${document.id}: ${document.title}\n  ${document.summary}`),
        ...(next < matches.length ? [`Next cursor: ${cursor(scope, digest, next)}`] : []),
      ].join("\n"),
    };
  }
  const document = documents.find((entry) => entry.id === args.document);
  if (!document) return { text: "Unknown documentation identifier. Use trust_documentation_list.", isError: true };
  const digest = hash(document.text);
  const offset = readCursor(args.cursor, document.id, digest, document.text.length);
  let end = Math.min(offset + limit, document.text.length);
  // Never split a Unicode surrogate pair between pages.
  if (end < document.text.length && /[\uD800-\uDBFF]/.test(document.text[end - 1] ?? "")) end++;
  return {
    text: [
      `DOCUMENT: ${document.id}`,
      `Title: ${document.title}`,
      `Digest: ${digest}`,
      `Characters: ${offset}-${end} of ${document.text.length}`,
      `Complete: ${end === document.text.length ? "yes" : "no"}`,
      ...(end < document.text.length ? [`Next cursor: ${cursor(document.id, digest, end)}`] : []),
      "Links beginning trust-doc:/// identify documents: pass the decoded path (without fragment) to trust_documentation_read. They are not browser URLs.",
      "CONTENT",
      document.text.slice(offset, end),
    ].join("\n"),
  };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function cursor(scope: string, digest: string, offset: number): string {
  return Buffer.from(JSON.stringify({ scope, digest, offset })).toString("base64url");
}
function readCursor(value: unknown, scope: string, digest: string, length: number): number {
  if (value === undefined) return 0;
  if (!text(value) || !/^[A-Za-z0-9_-]+$/.test(value)) invalid();
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      !record(parsed) ||
      parsed.scope !== scope ||
      parsed.digest !== digest ||
      typeof parsed.offset !== "number" ||
      !Number.isSafeInteger(parsed.offset) ||
      parsed.offset < 1 ||
      parsed.offset >= length ||
      value !== cursor(scope, digest, parsed.offset)
    )
      invalid();
    return parsed.offset;
  } catch {
    return invalid();
  }
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(value: unknown): value is string {
  return typeof value === "string";
}
function identifier(value: unknown): value is string {
  return (
    text(value) &&
    value.length <= 250 &&
    /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(value) &&
    !value.split("/").some((part) => part === "." || part === "..")
  );
}
function invalid(): never {
  throw new DocumentationArgumentsError("Invalid documentation arguments or cursor.");
}

export function documentationTools() {
  return [
    {
      name: "trust_documentation_list",
      title: "Discover TRUST documentation",
      description:
        "Discover packaged agent operational guides, canonical English reference pages and authored examples. Start at agents/README. Optional query searches the text; follow Next cursor until Complete is yes.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string", maxLength: 256 },
          cursor: { type: "string", maxLength: 1024 },
          limit: { type: "integer", minimum: 1, maximum: 25 },
        },
      },
    },
    {
      name: "trust_documentation_read",
      title: "Read TRUST documentation",
      description:
        "Read one packaged document by the identifier returned by discovery or a trust-doc link. Follow every Next cursor with the same document until Complete is yes. No arbitrary path access. Repository-only references are not packaged documents.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["document"],
        properties: {
          document: { type: "string", maxLength: 250 },
          cursor: { type: "string", maxLength: 1024 },
          limit: { type: "integer", minimum: 1, maximum: 12000 },
        },
      },
    },
  ];
}
