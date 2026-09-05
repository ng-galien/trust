import type { CompiledExpressionReference, CompiledProcedureRole } from "./procedure.js";

type RoleSource = CompiledProcedureRole["source"];
export type ProcedureRoleSourceHandlers<R> = {
  [K in RoleSource["kind"]]: (source: Extract<RoleSource, { kind: K }>) => R;
};

/** Total dispatch over the canonical role source, without compiler dependencies. */
export function matchProcedureRoleSource<R>(source: RoleSource, handlers: ProcedureRoleSourceHandlers<R>): R {
  // TypeScript cannot retain the discriminant/handler correlation through indexing.
  return handlers[source.kind](source as never);
}

export type ExpressionReferenceHandlers<R> = {
  [K in CompiledExpressionReference["kind"]]: (reference: Extract<CompiledExpressionReference, { kind: K }>) => R;
};

/** Total dispatch over references emitted by the qualification compiler. */
export function matchExpressionReference<R>(
  reference: CompiledExpressionReference,
  handlers: ExpressionReferenceHandlers<R>,
): R {
  return handlers[reference.kind](reference as never);
}
