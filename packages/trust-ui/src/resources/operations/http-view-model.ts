import type { Http, HttpValueSource } from "@trust/operation";

export function describeHttpLocation(http: Http): string {
  const path = http.path.map((segment) =>
    segment.kind === "input" ? `/{input.${segment.input}}` : `/{literal ${JSON.stringify(segment.value)}}`
  ).join("");
  const query = http.query.map((parameter) =>
    `${parameter.name}=${describeHttpValue(parameter.source)}`
  ).join("&");
  return `environment.${http.url.environment}${path}${query === "" ? "" : `?${query}`}`;
}

export function describeHttpValue(source: HttpValueSource): string {
  if (source.kind === "input") return `{input.${source.input}}`;
  if (source.kind === "environment") return `{environment.${source.environment}}`;
  return `{literal ${JSON.stringify(source.value)}}`;
}

export function describeHttpBody(http: Http): string | undefined {
  const body = http.body;
  if (body === undefined) return undefined;
  if (body.format === "text") return `Text ${describeHttpValue(body.source)}`;
  if (body.source === "input") return "JSON {input}";
  return `JSONata ${body.expression}`;
}

export function describeHttpBodyKind(http: Http): string | undefined {
  const body = http.body;
  if (body === undefined) return undefined;
  if (body.format === "text") return "Text";
  return body.source === "input" ? "Input JSON" : "JSONata";
}

export function describeAcceptedStatuses(http: Http): string {
  return http.acceptedStatuses?.join(", ") ?? "200–299";
}
