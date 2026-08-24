import { stepChoice, stepLiteral, stepOneOf, stepOptional, stepQuoted, stepRepeat, stepSequence, type StepGrammar } from "@trust/gherkin";

import { HTTP_METHODS } from "./http.js";

export const operationLanguage = {
  tags: { operation: "@operation:", version: "@version:", dsl: "@trust-dsl:", classification: "@x-" },
  dslVersion: "1",
  valueTypes: ["string", "number", "instant", "reference"] as const,
  environmentTypes: ["directory", "url", "string"] as const,
  cardinalities: ["one", "many"] as const,
  formats: ["JSON", "Text"] as const,
  httpMethods: HTTP_METHODS,
  phrases: {
    environment: "Environment",
    input: "Input",
    produced: "Produced fields",
    produce: "Produce with JSONata",
  },
  jsonata: {
    roots: ["steps", "input", "environment", "execution"] as const,
    functions: [
      "abs", "append", "assert", "average", "boolean", "ceil", "contains", "count", "distinct", "each",
      "exists", "filter", "floor", "formatBase", "formatNumber", "fromMillis", "join", "keys",
      "length", "lookup", "lowercase", "map", "match", "max", "merge", "millis", "min", "not",
      "number", "pad", "power", "reduce", "replace", "reverse", "round", "single", "sort", "split",
      "spread", "sqrt", "string", "substring", "substringAfter", "substringBefore", "sum", "toMillis",
      "trim", "type", "uppercase", "zip",
    ] as const,
    nodeTypes: ["binary", "block", "condition", "filter", "function", "name", "number", "path", "string", "unary", "value", "variable"] as const,
    binaryOperators: ["!=", "%", "&", "*", "+", "-", "/", "<", "<=", "=", ">", ">=", "and", "or"] as const,
  },
  stepResults: {
    shell: ["exitCode", "stdout", "stderr"],
    "file-read": ["relativePath", "content"],
    http: ["status", "headers", "body"],
  } as const,
  syntax: {
    types: ["Environment", "Input", "Produced", "Shell", "File", "HTTP", "Operation", "Execution"] as const,
    verbs: ["runs", "accepts", "sends", "appending", "with", "reads", "Produce"] as const,
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

const operationLiteral = (value: string, detail: string, capture?: string) => stepLiteral(value, detail, capture);
const operationQuoted = (slot: string, detail: string) => stepQuoted(slot, detail);
const appendInput = stepOptional(stepSequence(
  operationLiteral("and Input", "Append an Input value"),
  operationQuoted("append-input", "Operation Input"),
));
const httpValueSource = (prefix: string) => stepChoice(
  stepSequence(operationLiteral("from Input", "Value from an Input"), operationQuoted(`${prefix}-input`, "Operation Input")),
  stepSequence(operationLiteral("from Environment", "Value from the Environment"), operationQuoted(`${prefix}-environment`, "Operation Environment")),
  stepSequence(operationLiteral("as", "Literal value"), operationQuoted(`${prefix}-literal`, "Literal value")),
);
const httpPathSegment = stepChoice(
  stepSequence(operationLiteral("Input", "Path segment from an Input"), operationQuoted("path-input", "Operation Input")),
  stepSequence(operationLiteral("literal", "Literal path segment"), operationQuoted("path-literal", "Literal path segment")),
);

/** Canonical grammar of the sentences carried by Operation Steps. */
export const operationStepGrammar: StepGrammar = {
  productions: [
    { name: "environment", context: "background", expression: operationLiteral(operationLanguage.phrases.environment, "Environment interface table") },
    { name: "input", context: "background", expression: operationLiteral(operationLanguage.phrases.input, "Input interface table") },
    { name: "produced", context: "background", expression: operationLiteral(operationLanguage.phrases.produced, "Produced fields interface table") },
    {
      name: "shell-run",
      context: "scenario",
      expression: stepSequence(
        operationLiteral("Shell", "Shell command"),
        operationQuoted("step", "Step name"),
        operationLiteral("runs", "Executable to run"),
        operationQuoted("executable", "Executable"),
        operationLiteral("with cwd from Environment", "Working directory"),
        operationQuoted("environment", "Operation Environment"),
        appendInput,
      ),
    },
    {
      name: "shell-exits",
      context: "scenario",
      expression: stepSequence(
        operationLiteral("Shell", "Shell command"),
        operationQuoted("step", "Step name"),
        operationLiteral("accepts exits", "Accept non-zero exit codes"),
      ),
    },
    {
      name: "file-read",
      context: "scenario",
      expression: stepSequence(
        operationLiteral("File", "File read"),
        operationQuoted("step", "Step name"),
        operationLiteral("reads", "Path to read"),
        operationQuoted("path", "Relative file path"),
        operationLiteral("as", "Content format"),
        stepOneOf("format", operationLanguage.formats, "Content format"),
        operationLiteral("from Environment", "File root"),
        operationQuoted("environment", "Operation Environment"),
        appendInput,
      ),
    },
    {
      name: "http-statuses",
      context: "scenario",
      expression: stepSequence(
        operationLiteral("HTTP", "HTTP request"),
        operationQuoted("step", "Step name"),
        operationLiteral("accepts statuses", "Accept non-success statuses"),
      ),
    },
    {
      name: "http-request",
      context: "scenario",
      expression: stepSequence(
        operationLiteral("HTTP", "HTTP request"),
        operationQuoted("step", "Step name"),
        operationLiteral("sends", "HTTP method"),
        stepOneOf("http-method", operationLanguage.httpMethods, "HTTP method", true),
        operationLiteral("to Environment", "Target base URL"),
        operationQuoted("environment", "Operation Environment"),
        stepOptional(stepSequence(
          operationLiteral("appending", "URL path segments"),
          httpPathSegment,
          stepRepeat(stepChoice(
            stepSequence(operationLiteral("and Input", "Path segment from an Input"), operationQuoted("path-input", "Operation Input")),
            stepSequence(operationLiteral("and literal", "Literal path segment"), operationQuoted("path-literal", "Literal path segment")),
          )),
        )),
        stepRepeat(stepSequence(
          operationLiteral("with query", "Query parameter"),
          operationQuoted("query-name", "Query parameter name"),
          httpValueSource("query"),
        )),
        stepRepeat(stepSequence(
          operationLiteral("with header", "Request header"),
          operationQuoted("header-name", "Request header name"),
          httpValueSource("header"),
        )),
        stepOptional(stepChoice(
          operationLiteral("with Input as JSON body", "Whole Input as JSON body", "body-whole-input"),
          operationLiteral("with JSONata body", "JSONata request body", "body-jsonata"),
          stepSequence(operationLiteral("with Text body", "Text request body"), httpValueSource("body")),
        )),
        operationLiteral("and reads", "Response format"),
        stepChoice(
          stepOneOf("response-format", operationLanguage.formats, "Response format"),
          operationLiteral("no body", "Ignore the response body", "response-no-body"),
        ),
      ),
    },
    { name: "produce", context: "scenario", expression: operationLiteral(operationLanguage.phrases.produce, "Produce expression") },
  ],
};

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
  { label: "HTTP step", insertText: `When HTTP "\${1:step}" sends "\${2|${operationLanguage.httpMethods.join(",")}|}" to Environment "\${3:serviceUrl}" and reads \${4|JSON,Text,no body|}` },
  {
    label: operationLanguage.phrases.produce,
    insertText: `Then ${operationLanguage.phrases.produce}\n  """\n  { "\${1:field}": \${2:expression} }\n  """`,
  },
] as const;
