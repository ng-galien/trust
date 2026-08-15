type JsonataExpression = {
  evaluate(input: unknown): unknown | Promise<unknown>;
};

type JsonataFactory = (expression: string) => JsonataExpression;

const loadJsonata = async (): Promise<JsonataFactory> => {
  const module = await import("jsonata");
  const jsonata = (module.default ?? module) as unknown;
  if (typeof jsonata !== "function") {
    throw new Error("jsonata does not expose a transformation function.");
  }
  return jsonata as JsonataFactory;
};

const jsonOutput = (value: unknown): unknown => {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error("JSONata transformation must return JSON.");
  }
  return JSON.parse(serialized) as unknown;
};

export const transformJsonata = async (expression: string, input: unknown): Promise<unknown> => {
  const jsonata = await loadJsonata();
  return jsonOutput(await jsonata(expression).evaluate(input));
};
