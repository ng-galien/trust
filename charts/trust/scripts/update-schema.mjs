import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TRUST_CONFIGURATION_SCHEMA } from "../../../packages/trust-extension-sdk/dist/configuration.js";

const string = { type: "string" };
const nonempty = { type: "string", minLength: 1 };
const object = (properties, required = Object.keys(properties)) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});
const name = { type: "string", pattern: "^[a-z][a-z0-9-]*$", maxLength: 63 };
const port = { type: "integer", minimum: 1, maximum: 65535 };
export const schema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "TRUST Helm values",
  ...object({
    image: object({
      repository: nonempty,
      tag: nonempty,
      digest: { type: "string", pattern: "^(sha256:[a-f0-9]{64})?$" },
      pullPolicy: { enum: ["Always", "IfNotPresent", "Never"] },
    }),
    imagePullSecrets: { type: "array", items: object({ name: nonempty }) },
    nameOverride: string,
    fullnameOverride: string,
    replicaCount: { type: "integer", const: 1 },
    config: TRUST_CONFIGURATION_SCHEMA,
    environment: { type: "object", additionalProperties: { type: "string" } },
    secretEnvironment: {
      type: "array",
      items: object({ name: { type: "string", pattern: "^[A-Z_][A-Z0-9_]*$" }, secretName: nonempty, key: nonempty }),
    },
    configurationMounts: {
      type: "array",
      items: object({ name, kind: { enum: ["ConfigMap", "Secret"] }, resourceName: nonempty }),
    },
    persistence: object(
      {
        existingClaim: string,
        size: nonempty,
        storageClass: { type: ["string", "null"] },
        accessModes: {
          type: "array",
          minItems: 1,
          maxItems: 1,
          items: { enum: ["ReadWriteOnce", "ReadWriteOncePod"] },
        },
        retain: { type: "boolean" },
      },
      ["existingClaim", "size", "accessModes", "retain"],
    ),
    service: object({ type: { enum: ["ClusterIP", "LoadBalancer", "NodePort"] }, port }),
    ingress: object({
      enabled: { type: "boolean" },
      className: string,
      annotations: { type: "object", additionalProperties: string },
      host: nonempty,
      tls: {
        type: "array",
        items: object({ secretName: nonempty, hosts: { type: "array", minItems: 1, items: nonempty } }),
      },
    }),
    resources: { type: "object" },
    terminationGracePeriodSeconds: { type: "integer", minimum: 30, maximum: 600 },
    nodeSelector: { type: "object", additionalProperties: string },
    tolerations: { type: "array", items: { type: "object" } },
    affinity: { type: "object" },
  }),
};
if (process.argv[1] === fileURLToPath(import.meta.url))
  await writeFile(path.resolve(import.meta.dirname, "../values.schema.json"), JSON.stringify(schema, null, 2) + "\n");
