import { createHash } from "node:crypto";
import Ajv from "ajv";
import { Liquid } from "liquidjs";

export const renderer = "liquidjs@10.29.0";
const ajv = new Ajv({ allErrors: true, strict: true });
const liquid = new Liquid({
  parseLimit: 16000,
  renderLimit: 300,
  memoryLimit: 1000000,
  ownPropertyOnly: true,
  strictVariables: true,
  strictFilters: true,
  dynamicPartials: false,
  relativeReference: false,
  outputEscape: (value) =>
    String(value)
      .replace(/\\/g, "\\\\")
      .replace(/([`*_{}[\]<>|])/g, "\\$1")
      .replace(/\r?\n/g, " "),
});

export function validateTemplate(source, schema) {
  if (typeof source !== "string" || !source.trim() || source.length > 16000)
    throw new Error("Invalid Markdown template source.");
  if (!schema || typeof schema !== "object" || Array.isArray(schema) || JSON.stringify(schema).length > 8000)
    throw new Error("Invalid template data schema.");
  if (schema.type !== "object" || schema.additionalProperties !== false || !schema.properties)
    throw new Error("Template data schema must be a closed object.");
  try {
    ajv.compile(schema);
  } catch (error) {
    throw new Error(`Invalid template data schema: ${error.message}`);
  }
  const tags = [...source.matchAll(/\{%-?\s*([a-z][a-z0-9_]*)\b[\s\S]*?-?%\}/g)];
  if (
    tags.length !== (source.match(/\{%/g) ?? []).length ||
    tags.some(([, tag]) => !["if", "elsif", "else", "endif", "unless", "endunless", "for", "endfor"].includes(tag)) ||
    /\|\s*raw\b/.test(source)
  )
    throw new Error("Template uses an unsupported Liquid tag or filter.");
  try {
    liquid.parse(source);
  } catch (error) {
    throw new Error(`Invalid Liquid template: ${error.message}`);
  }
}

export async function renderPost(source, schema, data) {
  validateTemplate(source, schema);
  if (!data || typeof data !== "object" || Array.isArray(data) || JSON.stringify(data).length > 16000)
    throw new Error("Post data must be a bounded object.");
  const validate = ajv.compile(schema);
  if (!validate(data))
    throw new Error(`Post data does not match the template schema: ${ajv.errorsText(validate.errors)}`);
  let markdown;
  try {
    markdown = (await liquid.parseAndRender(source, { data })).trim();
  } catch (error) {
    throw new Error(`Template rendering failed: ${error.message}`);
  }
  if (!markdown || markdown.length > 16000) throw new Error("Rendered Markdown is empty or too long.");
  return { markdown, sha256: createHash("sha256").update(markdown).digest("hex"), renderer };
}
