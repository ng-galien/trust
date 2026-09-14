import type { MissionDefinition } from "@trust/extension-sdk";
import { matchMissionDefinition } from "@trust/extension-sdk/match";
import { type CompiledOperation, compileOperation } from "@trust/operation";
import { parseResourceReference, selectVersion } from "@trust/operation/version";
import { CatalogProcedureCompilationError, type CompiledProcedure, compileProcedure } from "@trust/procedure";

/** Compile a mission against catalog snapshots without publishing inline definitions. */
export function resolveMissionDefinition(
  definition: MissionDefinition,
  publishedOperations: readonly CompiledOperation[],
  procedures: readonly CompiledProcedure[],
): CompiledProcedure {
  const compile = (source: string, operations: readonly CompiledOperation[], sourceName: string): CompiledProcedure => {
    const visiting = new Set<string>();
    const resolve = (selected: CompiledProcedure): CompiledProcedure => {
      const identity = `${selected.procedure}@${selected.version}`;
      if (visiting.has(identity))
        throw new CatalogProcedureCompilationError(
          "dependency-cycle",
          `Procedure invocation cycle contains "${identity}"`,
          identity,
        );
      visiting.add(identity);
      const child = compileProcedure({
        source: selected.source,
        sourceName: identity,
        operations,
        procedures,
        resolveProcedure: resolve,
      });
      visiting.delete(identity);
      return child;
    };
    return compileProcedure({ source, sourceName, operations, procedures, resolveProcedure: resolve });
  };
  return matchMissionDefinition(definition, {
    published: ({ reference }) => {
      const parsed = parseResourceReference(reference);
      if (!parsed) throw new TypeError("Invalid mission Procedure reference");
      const version = selectVersion(
        procedures.filter((value) => value.procedure === parsed.name).map((value) => value.version),
        parsed.selector,
      );
      const selected = procedures.find((value) => value.procedure === parsed.name && value.version === version);
      if (!selected) throw new TypeError(`No published Procedure matches "${reference}"`);
      return compile(selected.source, publishedOperations, `${selected.procedure}@${selected.version}`);
    },
    inline: ({ procedureSource, operationSources }) => {
      const operations = [...publishedOperations];
      for (const [index, source] of operationSources.entries()) {
        const operation = compileOperation({ source, sourceName: `operations/${index + 1}.feature` });
        if (
          operations.some((value) => value.operation === operation.operation && value.version === operation.version)
        ) {
          throw new TypeError(
            `Inline Operation "${operation.operation}@${operation.version}" conflicts with an existing definition`,
          );
        }
        operations.push(operation);
      }
      const procedure = compile(procedureSource, operations, "procedure.feature");
      if (procedures.some((value) => value.procedure === procedure.procedure && value.version === procedure.version)) {
        throw new TypeError(
          `Inline Procedure "${procedure.procedure}@${procedure.version}" conflicts with a published definition`,
        );
      }
      return procedure;
    },
  });
}
