// Measures two interface rules on a checkout, relative to the current directory:
// - translations: each English catalogue and its French catalogue hold the same keys;
// - theme tokens: no style sheet writes a colour outside the files that define the theme tokens.
// Each finding names the key, or the file and line of the colour.
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

/** The only style sheets allowed to write colour values: they define the theme tokens. */
export const TOKEN_FILES = ["packages/trust-ui/src/tokens.css"];

/** Interface source roots of the host and of the TRUST extensions; `*` is one directory level. */
const INTERFACE_ROOTS = ["packages/*/src", "apps/*/src", "trust-extension/extensions/*/ui"];
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "build", "bundle", "coverage", "test-results", ".git"]);
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);

/** Keywords that are never hard-coded colours. */
const ALLOWED_KEYWORDS = new Set(["transparent", "currentcolor", "inherit", "initial", "unset", "revert", "none"]);
const NAMED_COLOURS = new Set(
  (
    "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood " +
    "cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray " +
    "darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen " +
    "darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue " +
    "firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew " +
    "hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan " +
    "lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray " +
    "lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue " +
    "mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred " +
    "midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid " +
    "palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple " +
    "rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue " +
    "slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white " +
    "whitesmoke yellow yellowgreen"
  ).split(" "),
);
/** Properties whose values hold names (fonts, animations, grid areas), where a colour word is not a colour. */
const NAME_PROPERTIES = new Set([
  "font",
  "font-family",
  "animation",
  "animation-name",
  "transition",
  "transition-property",
  "will-change",
  "grid-area",
  "grid-row",
  "grid-column",
  "grid-template",
  "grid-template-areas",
  "container",
  "container-name",
  "view-transition-name",
  "counter-reset",
  "counter-increment",
  "list-style-type",
]);
const HEX_COLOUR = /(?<![\w-])#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![\w-])/giu;
const COLOUR_FUNCTION = /(?<![\w-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|device-cmyk)\(/giu;
const WORD = /(?<![\w-])[a-z]+(?![\w-])/giu;

export async function measureInterfaceRules(root = ".") {
  const directories = await interfaceDirectories(root);
  const files = (await Promise.all(directories.map((directory) => listFiles(root, directory)))).flat();
  const findings = [
    ...(await translationFindings(root, directories, files)),
    ...(await colourFindings(
      root,
      files.filter((file) => file.endsWith(".css")),
    )),
  ];
  return { findings, styleSheets: files.filter((file) => file.endsWith(".css")).length };
}

// ---------------------------------------------------------------------------------------------------------------
// Theme tokens

async function colourFindings(root, styleSheets) {
  const findings = [];
  for (const file of styleSheets.sort()) {
    if (TOKEN_FILES.includes(file)) continue;
    const source = await readFile(path.join(root, file), "utf8");
    for (const { line, colour } of hardCodedColours(source)) findings.push(`${file}:${line} writes colour ${colour}`);
  }
  return findings;
}

/** The colours written in the declarations of one style sheet, with their line. */
export function hardCodedColours(source) {
  const text = blankStringsCommentsAndUrls(source);
  const lineStarts = [0];
  for (let index = 0; index < text.length; index++) if (text[index] === "\n") lineStarts.push(index + 1);
  const lineOf = (offset) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (lineStarts[middle] <= offset) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };
  const colours = [];
  let start = 0;
  for (let index = 0; index <= text.length; index++) {
    const character = text[index];
    if (index < text.length && character !== "{" && character !== "}" && character !== ";") continue;
    const segment = text.slice(start, index);
    const segmentStart = start;
    start = index + 1;
    if (character === "{") continue;
    const colon = segment.indexOf(":");
    if (colon < 0) continue;
    const property = segment.slice(0, colon).trim().toLowerCase();
    if (!/^(?:--)?[a-z][\w-]*$/u.test(property)) continue;
    const valueOffset = segmentStart + colon + 1;
    // A custom property reference such as var(--color-text) is a token, never a colour.
    const value = segment.slice(colon + 1).replace(/--[\w-]+/gu, (name) => " ".repeat(name.length));
    const found = [];
    for (const match of value.matchAll(HEX_COLOUR)) found.push(match);
    for (const match of value.matchAll(COLOUR_FUNCTION)) found.push(match);
    if (!NAME_PROPERTIES.has(property)) {
      for (const match of value.matchAll(WORD)) {
        const word = match[0].toLowerCase();
        if (NAMED_COLOURS.has(word) && !ALLOWED_KEYWORDS.has(word)) found.push(match);
      }
    }
    for (const match of found.sort((a, b) => a.index - b.index)) {
      const offset = valueOffset + match.index;
      colours.push({ line: lineOf(offset), colour: colourText(value, match) });
    }
  }
  return colours;
}

function colourText(value, match) {
  if (!match[0].endsWith("(")) return match[0];
  let depth = 0;
  for (let index = match.index + match[0].length - 1; index < value.length; index++) {
    if (value[index] === "(") depth++;
    if (value[index] === ")" && --depth === 0) return value.slice(match.index, index + 1).replace(/\s+/gu, " ");
  }
  return match[0];
}

/** Replaces comments, quoted strings and url() contents by spaces, keeping every offset and line break. */
function blankStringsCommentsAndUrls(source) {
  const blank = (text) => text.replace(/[^\n]/gu, " ");
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, blank)
    .replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/gu, blank)
    .replace(/(?<![\w-])url\(([^)]*)\)/giu, (_match, inner) => `url(${blank(inner)})`);
}

// ---------------------------------------------------------------------------------------------------------------
// Translations

async function translationFindings(root, directories, files) {
  const findings = [];
  for (const directory of directories) {
    for (const english of await catalogueDirectories(root, directory, "en")) {
      const french = `${path.posix.dirname(english)}/fr`;
      findings.push(...(await structuredCatalogueFindings(root, english, french)));
    }
  }
  const catalogues = files.filter((file) => /^trust-extension\/extensions\/[^/]+\/ui\/i18n\.tsx?$/u.test(file));
  for (const catalogue of catalogues.sort()) {
    const directory = path.posix.dirname(catalogue);
    const sources = files.filter(
      (file) => file !== catalogue && file.startsWith(`${directory}/`) && SOURCE_EXTENSIONS.has(path.extname(file)),
    );
    const extension = path.posix.dirname(directory);
    const modules = (await entries(root, extension))
      .filter((entry) => entry.isFile() && /\.(?:mjs|js|ts)$/u.test(entry.name))
      .map((entry) => `${extension}/${entry.name}`);
    findings.push(...(await textKeyedCatalogueFindings(root, catalogue, sources, modules)));
  }
  return findings;
}

/** `i18n/en` directories below one interface root. */
async function catalogueDirectories(root, directory, language) {
  const found = [];
  const visit = async (relative) => {
    for (const entry of await entries(root, relative)) {
      if (!entry.isDirectory() || SKIPPED_DIRECTORIES.has(entry.name)) continue;
      const child = `${relative}/${entry.name}`;
      if (entry.name === language && path.posix.basename(relative) === "i18n") found.push(child);
      else await visit(child);
    }
  };
  await visit(directory);
  return found.sort();
}

/**
 * A structured catalogue is one module per area in `i18n/en` and `i18n/fr`, each exporting one nested object. The key
 * of a leaf is its path, prefixed by the module name except for the index that merges the modules.
 */
async function structuredCatalogueFindings(root, englishDirectory, frenchDirectory) {
  const englishFiles = (await listFiles(root, englishDirectory)).filter((file) =>
    SOURCE_EXTENSIONS.has(path.extname(file)),
  );
  const frenchFiles = (await listFiles(root, frenchDirectory)).filter((file) =>
    SOURCE_EXTENSIONS.has(path.extname(file)),
  );
  const modules = new Set(
    [...englishFiles, ...frenchFiles].map((file) => file.slice(path.posix.dirname(file).length + 1)),
  );
  const findings = [];
  for (const module of [...modules].sort()) {
    const englishFile = `${englishDirectory}/${module}`;
    const frenchFile = `${frenchDirectory}/${module}`;
    const prefix = module.replace(/\.tsx?$/u, "") === "index" ? "" : `${module.replace(/\.tsx?$/u, "")}.`;
    const english = englishFiles.includes(englishFile) ? await objectKeys(root, englishFile, prefix) : new Set();
    const french = frenchFiles.includes(frenchFile) ? await objectKeys(root, frenchFile, prefix) : new Set();
    const pair = `${path.posix.dirname(englishDirectory)}/{en,fr}/${module}`;
    for (const key of english) if (!french.has(key)) findings.push(`${pair}: key "${key}" is in English only`);
    for (const key of french) if (!english.has(key)) findings.push(`${pair}: key "${key}" is in French only`);
  }
  return findings;
}

async function objectKeys(root, file, prefix) {
  const source = await parse(root, file);
  const keys = new Set();
  const flatten = (object, path) => {
    for (const property of object.properties) {
      if (ts.isShorthandPropertyAssignment(property)) keys.add(`${path}${property.name.text}`);
      if (!ts.isPropertyAssignment(property)) continue;
      const name = propertyName(property.name);
      if (name === undefined) continue;
      const value = unwrap(property.initializer);
      if (ts.isObjectLiteralExpression(value)) flatten(value, `${path}${name}.`);
      else keys.add(`${path}${name}`);
    }
  };
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const value = declaration.initializer && unwrap(declaration.initializer);
      if (value && ts.isObjectLiteralExpression(value)) flatten(value, prefix);
    }
  }
  return keys;
}

/**
 * A text-keyed catalogue holds the French table keyed by the English text; the English catalogue is the set of texts
 * that the interface gives to `t()`. Each literal text given to `t()` needs a French entry. A French entry is English
 * when a template given to `t()` matches it, or when the extension writes it as a string: a map of labels translated
 * later, or a value of its domain such as an interaction kind.
 */
async function textKeyedCatalogueFindings(root, catalogue, sources, modules) {
  const french = new Set();
  for (const statement of (await parse(root, catalogue)).statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const value = declaration.initializer && unwrap(declaration.initializer);
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== "fr" || !value) continue;
      if (!ts.isObjectLiteralExpression(value)) continue;
      for (const property of value.properties) {
        const name = ts.isPropertyAssignment(property) ? propertyName(property.name) : undefined;
        if (name !== undefined) french.add(name);
      }
    }
  }
  const english = new Map();
  const templates = [];
  const literals = new Set();
  for (const file of [...sources, ...modules].sort()) {
    const source = await parse(root, file);
    const interfaceSource = sources.includes(file);
    const visit = (node) => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) literals.add(node.text);
      if (interfaceSource && ts.isCallExpression(node) && isTranslate(node.expression) && node.arguments[0]) {
        for (const leaf of literalLeaves(node.arguments[0])) {
          if (ts.isTemplateExpression(leaf)) templates.push(templatePattern(leaf));
          else if (!english.has(leaf.text))
            english.set(leaf.text, `${file}:${source.getLineAndCharacterOfPosition(leaf.getStart(source)).line + 1}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  const findings = [];
  for (const [key, location] of english)
    if (!french.has(key)) findings.push(`${catalogue}: key "${key}" is in English only (${location})`);
  for (const key of french)
    if (!english.has(key) && !literals.has(key) && !templates.some((pattern) => pattern.test(key)))
      findings.push(`${catalogue}: key "${key}" is in French only`);
  return findings;
}

/** The texts that a template such as `kind|${kind}` produces: its literal parts around any substitution. */
function templatePattern(template) {
  const literal = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(
    `^${literal(template.head.text)}${template.templateSpans.map((span) => `.+${literal(span.literal.text)}`).join("")}$`,
    "u",
  );
}

function isTranslate(callee) {
  return (
    (ts.isIdentifier(callee) && callee.text === "t") ||
    (ts.isPropertyAccessExpression(callee) && callee.name.text === "t")
  );
}

/** The literal texts that an argument of `t()` can take. */
function literalLeaves(node) {
  const value = unwrap(node);
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value) || ts.isTemplateExpression(value))
    return [value];
  if (ts.isConditionalExpression(value)) return [...literalLeaves(value.whenTrue), ...literalLeaves(value.whenFalse)];
  if (
    ts.isBinaryExpression(value) &&
    [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(value.operatorToken.kind)
  )
    return [...literalLeaves(value.left), ...literalLeaves(value.right)];
  return [];
}

function unwrap(node) {
  let value = node;
  while (
    ts.isParenthesizedExpression(value) ||
    ts.isAsExpression(value) ||
    ts.isSatisfiesExpression(value) ||
    ts.isTypeAssertionExpression(value)
  )
    value = value.expression;
  return value;
}

function propertyName(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

async function parse(root, file) {
  const text = await readFile(path.join(root, file), "utf8");
  return ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Files

async function interfaceDirectories(root) {
  const directories = [];
  for (const pattern of INTERFACE_ROOTS) {
    const [base, rest] = pattern.split("/*/");
    for (const entry of await entries(root, base)) {
      if (!entry.isDirectory() || SKIPPED_DIRECTORIES.has(entry.name)) continue;
      const directory = `${base}/${entry.name}/${rest}`;
      if (await isDirectory(path.join(root, directory))) directories.push(directory);
    }
  }
  return directories.sort();
}

async function listFiles(root, directory) {
  const files = [];
  for (const entry of await entries(root, directory)) {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) files.push(...(await listFiles(root, relative)));
    } else if (entry.isFile()) files.push(relative);
  }
  return files;
}

async function entries(root, directory) {
  try {
    return await readdir(path.join(root, directory), { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return [];
    throw error;
  }
}

async function isDirectory(absolute) {
  try {
    return (await stat(absolute)).isDirectory();
  } catch {
    return false;
  }
}
