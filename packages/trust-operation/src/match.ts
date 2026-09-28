import type { OperationCredentialReference } from "./credential.js";
import type { HttpBody, HttpFormat, HttpHeaderSource, HttpPathSegment, HttpValueSource } from "./http.js";
import type { OperationStep, OperationValueType } from "./operation.js";
import type { ShellArgument } from "./shell.js";

/** Total visitor over the canonical Operation step union. No partial fallback. */
export type OperationStepHandlers<R> = {
  [K in OperationStep["type"]]: (step: Extract<OperationStep, { type: K }>) => R;
};

export function matchOperationStep<R>(step: OperationStep, handlers: OperationStepHandlers<R>): R {
  // The discriminant selects exactly the handler accepting this variant. TypeScript
  // cannot retain that correlation through a computed property access.
  return handlers[step.type](step as never);
}

export type OperationValueTypeHandlers<R> = { [T in OperationValueType]: () => R };

export function matchOperationValueType<R>(type: OperationValueType, handlers: OperationValueTypeHandlers<R>): R {
  return handlers[type]();
}

export type ShellArgumentHandlers<R> = {
  [K in ShellArgument["kind"]]: (argument: Extract<ShellArgument, { kind: K }>) => R;
};

export function matchShellArgument<R>(argument: ShellArgument, handlers: ShellArgumentHandlers<R>): R {
  return handlers[argument.kind](argument as never);
}

export type HttpValueSourceHandlers<R> = {
  [K in HttpValueSource["kind"]]: (source: Extract<HttpValueSource, { kind: K }>) => R;
};

export function matchHttpValueSource<R>(source: HttpValueSource, handlers: HttpValueSourceHandlers<R>): R {
  return handlers[source.kind](source as never);
}

export type HttpHeaderSourceHandlers<R> = {
  [K in HttpHeaderSource["kind"]]: (source: Extract<HttpHeaderSource, { kind: K }>) => R;
};

export function matchHttpHeaderSource<R>(source: HttpHeaderSource, handlers: HttpHeaderSourceHandlers<R>): R {
  return handlers[source.kind](source as never);
}

/** Total visitor over the three places a compiled step consumes a declared Credential. */
export type OperationCredentialReferenceHandlers<R> = {
  [K in OperationCredentialReference["kind"]]: (reference: Extract<OperationCredentialReference, { kind: K }>) => R;
};

export function matchOperationCredentialReference<R>(
  reference: OperationCredentialReference,
  handlers: OperationCredentialReferenceHandlers<R>,
): R {
  return handlers[reference.kind](reference as never);
}

export type HttpPathSegmentHandlers<R> = {
  [K in HttpPathSegment["kind"]]: (segment: Extract<HttpPathSegment, { kind: K }>) => R;
};

export function matchHttpPathSegment<R>(segment: HttpPathSegment, handlers: HttpPathSegmentHandlers<R>): R {
  return handlers[segment.kind](segment as never);
}

/** HTTP bodies discriminate first by format, then by source for JSON bodies. */
export type HttpBodyHandlers<R> = {
  [B in HttpBody as B extends { format: "json"; source: infer S extends string } ? S : B["format"]]: (body: B) => R;
};

export function matchHttpBody<R>(body: HttpBody, handlers: HttpBodyHandlers<R>): R {
  if (body.format === "json") return handlers[body.source](body as never);
  return handlers[body.format](body);
}

export type HttpFormatHandlers<R> = { [F in HttpFormat]: () => R };

export function matchHttpFormat<R>(format: HttpFormat, handlers: HttpFormatHandlers<R>): R {
  return handlers[format]();
}

export type FileFormatHandlers<R> = { [F in import("./file-read.js").FileFormat]: () => R };

export function matchFileFormat<R>(format: import("./file-read.js").FileFormat, handlers: FileFormatHandlers<R>): R {
  return handlers[format]();
}
