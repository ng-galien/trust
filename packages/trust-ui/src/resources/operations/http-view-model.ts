import type { Http, HttpValueSource } from "@trust/operation";
import { matchHttpBody, matchHttpPathSegment, matchHttpValueSource } from "@trust/operation/match";

export function describeHttpLocation(http: Http): string {
  const path = http.path
    .map((segment) =>
      matchHttpPathSegment(segment, {
        input: (value) => `/{input.${value.input}}`,
        literal: (value) => `/{literal ${JSON.stringify(value.value)}}`,
      }),
    )
    .join("");
  const query = http.query.map((parameter) => `${parameter.name}=${describeHttpValue(parameter.source)}`).join("&");
  return `environment.${http.url.environment}${path}${query === "" ? "" : `?${query}`}`;
}

export function describeHttpValue(source: HttpValueSource): string {
  return matchHttpValueSource(source, {
    input: (value) => `{input.${value.input}}`,
    environment: (value) => `{environment.${value.environment}}`,
    literal: (value) => `{literal ${JSON.stringify(value.value)}}`,
  });
}

export function describeHttpBody(http: Http): string | undefined {
  const body = http.body;
  if (body === undefined) return undefined;
  return matchHttpBody(body, {
    text: (value) => `Text ${describeHttpValue(value.source)}`,
    input: () => "JSON {input}",
    jsonata: (value) => `JSONata ${value.expression}`,
  });
}

export function describeHttpBodyKind(http: Http): string | undefined {
  const body = http.body;
  if (body === undefined) return undefined;
  return matchHttpBody(body, {
    text: () => "Text",
    input: () => "Input JSON",
    jsonata: () => "JSONata",
  });
}

export function describeAcceptedStatuses(http: Http): string {
  return http.acceptedStatuses?.join(", ") ?? "200–299";
}
