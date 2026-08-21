export const operationLanguage = {
  tags: { operation: "@operation:", version: "@version:", dsl: "@trust-dsl:", classification: "@x-" },
  dslVersion: "1",
  valueTypes: ["string", "number", "instant", "reference"] as const,
  environmentTypes: ["directory", "url"] as const,
  cardinalities: ["one", "many"] as const,
  formats: ["JSON", "Text"] as const,
  phrases: {
    environment: "Environment",
    input: "Input",
    produced: "Produced fields",
    produce: "Produce with JSONata",
  },
  jsonata: {
    roots: ["steps", "input", "environment"] as const,
    functions: [
      "abs", "append", "average", "boolean", "ceil", "contains", "count", "distinct", "each",
      "exists", "filter", "floor", "formatBase", "formatNumber", "fromMillis", "join", "keys",
      "length", "lookup", "lowercase", "map", "match", "max", "merge", "millis", "min", "not",
      "number", "pad", "power", "reduce", "replace", "reverse", "round", "single", "sort", "split",
      "spread", "sqrt", "string", "substring", "substringAfter", "substringBefore", "sum", "toMillis",
      "trim", "type", "uppercase", "zip",
    ] as const,
    nodeTypes: ["binary", "block", "condition", "function", "name", "number", "path", "string", "unary", "value", "variable"] as const,
    binaryOperators: ["!=", "%", "&", "*", "+", "-", "/", "<", "<=", "=", ">", ">=", "and", "or"] as const,
  },
  stepResults: {
    shell: ["exitCode", "stdout", "stderr"],
    "file-read": ["relativePath", "content"],
    http: ["status", "headers", "body"],
  } as const,
  syntax: {
    types: ["Environment", "Input", "Produced", "Shell", "File", "HTTP", "Operation"] as const,
    verbs: ["runs", "accepts", "gets", "appending", "posts", "reads", "Produce"] as const,
  },
  template: `# language: en
@trust-dsl:1 @operation:domain.action @version:1.0.0
Feature: Describe what this operation observes

  Background: Operation interface
    Given Environment
      | name          | type      |
      | workspaceRoot | directory |
    And Input
      | input   | type      | cardinality |
      | project | reference | one         |
    And Produced fields
      | field       | type   | cardinality | domain                |
      | workingTree | string | one         | enum "clean", "dirty" |

  Scenario: Run
    When Shell "status" runs "git" with cwd from Environment "workspaceRoot"
      | argument       | source  |
      | status         | literal |
      | --porcelain=v1 | literal |
    Then Produce with JSONata
      """
      {
        "workingTree": $trim(steps.status.stdout) = "" ? "clean" : "dirty"
      }
      """
`,
} as const;

export const operationHighlightVocabulary = {
  roots: operationLanguage.jsonata.roots,
  functions: operationLanguage.jsonata.functions,
  types: operationLanguage.syntax.types,
  verbs: operationLanguage.syntax.verbs,
} as const;

export const operationAuthoringSnippets = [
  {
    label: "Environment interface",
    insertText: `Given ${operationLanguage.phrases.environment}\n  | name | type |\n  | \${1:name} | \${2|${operationLanguage.environmentTypes.join(",")}|} |`,
  },
  {
    label: "Input interface",
    insertText: `And ${operationLanguage.phrases.input}\n  | input | type | cardinality |\n  | \${1:name} | \${2|${operationLanguage.valueTypes.join(",")}|} | \${3|${operationLanguage.cardinalities.join(",")}|} |`,
  },
  {
    label: "Produced fields interface",
    insertText: `And ${operationLanguage.phrases.produced}\n  | field | type | cardinality | domain |\n  | \${1:name} | \${2|${operationLanguage.valueTypes.join(",")}|} | \${3|${operationLanguage.cardinalities.join(",")}|} | \${4:any} |`,
  },
  { label: "Shell step", insertText: `When Shell "\${1:step}" runs "\${2:command}" with cwd from Environment "\${3:workspaceRoot}"` },
  { label: "File step", insertText: `When File "\${1:step}" reads "\${2:path}" as \${3|${operationLanguage.formats.join(",")}|} from Environment "\${4:workspaceRoot}"` },
  { label: "HTTP GET step", insertText: `When HTTP "\${1:step}" gets Environment "\${2:serviceUrl}" as \${3|${operationLanguage.formats.join(",")}|}` },
  { label: "HTTP POST step", insertText: `When HTTP "\${1:step}" posts Input as JSON to Environment "\${2:serviceUrl}" and reads JSON` },
  {
    label: operationLanguage.phrases.produce,
    insertText: `Then ${operationLanguage.phrases.produce}\n  """\n  { "\${1:field}": \${2:expression} }\n  """`,
  },
] as const;
