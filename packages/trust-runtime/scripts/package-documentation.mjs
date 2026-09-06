import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createProcessor } from "@mdx-js/mdx";
import { operationLanguage } from "@trust/operation/language";
import { procedureLanguage } from "@trust/procedure/language";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import { parse as parseYaml } from "yaml";

// Build-only access to canonical content; no UI renderer or implementation is loaded.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const processor = createProcessor({ remarkPlugins: [remarkFrontmatter, remarkGfm] });
const markdownProcessor = createProcessor({ format: "md", remarkPlugins: [remarkFrontmatter, remarkGfm] });
const entries = [];
async function collect(directory, prefix, extension) {
  for (const entry of (await readdir(path.join(root, directory), { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await collect(relative, `${prefix}/${entry.name}`, extension);
    else if (entry.name.endsWith(extension))
      entries.push({ file: relative, id: `${prefix}/${entry.name.slice(0, -extension.length)}` });
  }
}
await collect("docs/agents", "agents", ".md");
await collect("packages/trust-ui/src/docs/content/en", "reference", ".mdx");
await collect("assets/operations", "examples/operations", ".feature");
await collect("assets/procedures", "examples/procedures", ".feature");
for (const [file, id] of [
  ["AGENTS.md", "references/project-agent-guide"],
  ["packages/trust-extension-sdk/README.md", "references/extension-sdk"],
  ["assets/skills/trust/SKILL.md", "references/runner"],
  ["assets/skills/trust/references/results.md", "references/runner-results"],
  ["extensions/coordination/README.md", "references/coordination"],
  ["extensions/coordination/DELEGATION.md", "references/delegation"],
  ["extensions/dragon-heist/README.md", "references/dragon-heist"],
  ["extensions/dragon-heist/extension.json", "examples/dragon-heist-manifest"],
  ["extensions/coordination/extension.json", "examples/coordination-manifest"],
])
  entries.push({ file, id });
const byFile = new Map(entries.map((entry) => [entry.file, entry]));
const docUri = (id, fragment = "") => `trust-doc:///${id}${fragment}`;
function link(url, file) {
  if (url.startsWith("#")) return docUri(byFile.get(file).id, url);
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  const [pathname, fragment] = url.split("#", 2);
  let target;
  if (pathname.startsWith("/docs")) {
    const slug = pathname.replace(/^\/docs\/?/, "");
    target =
      byFile.get(`packages/trust-ui/src/docs/content/en/${slug || "index"}.mdx`) ??
      byFile.get(`packages/trust-ui/src/docs/content/en/${slug}/index.mdx`);
    if (!target) throw new Error(`Unknown documentation link ${url} in ${file}`);
  } else target = byFile.get(path.posix.normalize(path.posix.join(path.posix.dirname(file), pathname)));
  return target ? docUri(target.id, fragment ? `#${fragment}` : "") : undefined;
}
function staticValue(node) {
  if (!node) return "";
  switch (node.type) {
    case "Program":
      return staticValue(node.body[0]);
    case "ExpressionStatement":
      return staticValue(node.expression);
    case "Literal":
      return node.value;
    case "JSXFragment":
      return node.children.map(staticValue).join("");
    case "JSXText":
      return node.value;
    case "JSXExpressionContainer":
      return staticValue(node.expression);
    case "JSXEmptyExpression":
      return "";
    case "JSXElement": {
      const name = node.openingElement.name.name;
      const value = node.children.map(staticValue).join("");
      if (name === "br") return "\n";
      if (["strong", "b"].includes(name)) return `**${value}**`;
      if (name === "code") return `\`${value}\``;
      if (name === "li") return `\n- ${value}`;
      if (["p", "ul", "ol"].includes(name)) return `\n${value}\n`;
      throw new Error(`Unsupported static JSX ${name}`);
    }
    case "ObjectExpression":
      return Object.fromEntries(
        node.properties.map((property) => {
          if (property.type !== "Property" || property.computed || property.kind !== "init")
            throw new Error("Non-static documentation property");
          return [property.key.name ?? property.key.value, staticValue(property.value)];
        }),
      );
    case "ArrayExpression":
      return node.elements.map(staticValue);
    default:
      throw new Error(`Unsupported documentation expression ${node.type}`);
  }
}
function attribute(node, name) {
  const found = node.attributes.find((value) => value.type === "mdxJsxAttribute" && value.name === name);
  if (!found) return undefined;
  return typeof found.value === "object" && found.value !== null ? staticValue(found.value.data?.estree) : found.value;
}
function languageTable(kind) {
  const qualification = procedureLanguage.qualification;
  const rows =
    kind === "OperationLanguageReference"
      ? [
          ["Roots", operationLanguage.jsonata.roots],
          ["Operators", operationLanguage.jsonata.binaryOperators],
          ["Functions", operationLanguage.jsonata.functions.map((name) => `$${name}`)],
        ]
      : [
          ["Roots", Object.values(qualification.roots)],
          ["Operators", Object.values(qualification.operators).flatMap(Object.keys)],
          ["Math", Object.keys(qualification.mathFunctions).map((name) => `Math.${name}`)],
          ["Collections", Object.keys(qualification.collectionMethods)],
          ["Strings", Object.keys(qualification.stringMethods)],
        ];
  return rows.map(([label, values]) => `- ${label}: ${values.map((value) => `\`${value}\``).join(", ")}`).join("\n");
}
function render(source, node, file) {
  if (node.type === "yaml") return "";
  if (node.type === "mdxjsEsm" || node.type === "mdxFlowExpression" || node.type === "mdxTextExpression") {
    throw new Error(`Unsupported executable documentation content in ${file}`);
  }
  const inner = () => {
    let cursor = node.position.start.offset;
    let output = "";
    for (const child of node.children ?? []) {
      output += source.slice(cursor, child.position.start.offset) + render(source, child, file);
      cursor = child.position.end.offset;
    }
    return output + source.slice(cursor, node.position.end.offset);
  };
  if (node.type === "link") {
    const label = node.children.map((child) => render(source, child, file)).join("");
    const target = link(node.url, file);
    return target
      ? `[${label}](${target})`
      : `${label} (repository or application reference, not packaged: \`${node.url}\`)`;
  }
  if (node.type === "image") return `[Image: ${node.alt || node.url}; visual asset is not packaged for MCP.]`;
  if (node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement") {
    const name = node.name;
    const contents = node.children.map((child) => render(source, child, file)).join("\n");
    if (name === "code") return `\`${contents}\``;
    if (["OperationLanguageReference", "ProcedureLanguageReference"].includes(name)) return languageTable(name);
    if (name === "PageCards") {
      const id = byFile.get(file).id.replace(/\/index$/, "");
      return entries
        .filter((entry) => entry.id.startsWith(`${id}/`) && entry.file !== file)
        .map((entry) => `- [${entry.id}](${docUri(entry.id)})`)
        .join("\n");
    }
    if (["ArchitectureFigure", "ModelFigure"].includes(name))
      return "[Visual diagram in the IHM; surrounding text describes the model.]";
    if (name === "Compare")
      return `${attribute(node, "leftTitle")}:\n${attribute(node, "left")}\n\n${attribute(node, "rightTitle")}:\n${attribute(node, "right")}`;
    if (name === "Screenshot") {
      const legend = attribute(node, "legend") ?? {};
      return `[Screenshot: ${attribute(node, "caption") ?? attribute(node, "id")}; image available in the IHM.]\n${Object.entries(
        legend,
      )
        .map(([key, value]) => `- ${key}: ${value}`)
        .join("\n")}`;
    }
    if (["Term", "Steps"].includes(name)) return contents;
    if (name === "Legend") {
      return Object.entries(attribute(node, "items") ?? {})
        .map(([key, value]) => `- ${key}: ${value}`)
        .join("\n");
    }
    if (["Step", "Details", "Callout", "Figure"].includes(name)) {
      const heading = attribute(node, "title") ?? attribute(node, "caption");
      return `${heading ? `\n**${heading}**\n\n` : ""}${contents}`;
    }
    throw new Error(`Unsupported MDX component ${name} in ${file}`);
  }
  return inner();
}
const documents = [];
for (const entry of entries) {
  const source = await readFile(path.join(root, entry.file), "utf8");
  const isSource = /\.(feature|json)$/.test(entry.file);
  const tree = isSource ? undefined : (entry.file.endsWith(".mdx") ? processor : markdownProcessor).parse(source);
  const metadata = tree?.children.find((node) => node.type === "yaml");
  const frontmatter = metadata ? parseYaml(metadata.value) : {};
  const title =
    frontmatter.title ?? source.match(/^# (.+)$/m)?.[1] ?? source.match(/^Feature: (.+)$/m)?.[1] ?? entry.id;
  const summary = frontmatter.summary ?? `Packaged ${isSource ? "authored source" : "guide"}: ${title}.`;
  const rendered = isSource ? undefined : render(source, tree, entry.file).trim();
  documents.push({
    id: entry.id,
    title,
    summary,
    text: isSource
      ? `# ${title}\n\nSource: ${entry.file}\n\n\`\`\`${entry.file.endsWith(".json") ? "json" : "gherkin"}\n${source}\`\`\`\n`
      : render(rendered, markdownProcessor.parse(rendered), entry.file).trim(),
  });
}
documents.sort((a, b) => (a.id === "agents/README" ? -1 : b.id === "agents/README" ? 1 : a.id.localeCompare(b.id)));
const output = new URL("../dist/documentation/", import.meta.url);
await mkdir(output, { recursive: true });
await writeFile(new URL("catalog.json", output), `${JSON.stringify({ format: 1, documents })}\n`);
console.log(`Packaged ${documents.length} documentation entries.`);
