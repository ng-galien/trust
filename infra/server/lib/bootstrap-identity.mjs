import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { readFile } from "node:fs/promises";

export const DEFAULT_IDENTITIES = Object.freeze({
  publisher: "spiffe://trust-test/skill-publishers/local-skills",
  distributionVerifier: "spiffe://trust-test/distribution-verifiers/server",
  operator: "spiffe://trust-test/operators/bootstrap",
  observer: "spiffe://trust-test/observers/test-environment",
  runtime: "spiffe://trust-test/skill-runtimes/local-skills",
});

export async function buildServerPrincipalConfiguration(environment = process.env) {
  const privateKey = await distributionVerifierPrivateKey(environment);
  const publicKey = createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
  const identities = Object.freeze({
    publisher: identity(environment.TRUST_PUBLISHER_IDENTITY ?? DEFAULT_IDENTITIES.publisher),
    distributionVerifier: identity(
      environment.TRUST_DISTRIBUTION_VERIFIER_IDENTITY ?? DEFAULT_IDENTITIES.distributionVerifier,
    ),
    operator: identity(environment.TRUST_OPERATOR_IDENTITY ?? DEFAULT_IDENTITIES.operator),
    observer: identity(environment.TRUST_OBSERVER_IDENTITY ?? DEFAULT_IDENTITIES.observer),
    runtime: identity(environment.TRUST_SKILL_RUNTIME_IDENTITY ?? DEFAULT_IDENTITIES.runtime),
    process: identity(required(environment, "TRUST_SKILL_PROCESS_IDENTITY")),
  });
  if (new Set(Object.values(identities)).size !== Object.values(identities).length) {
    throw new TypeError("server registry identities must be distinct");
  }
  const principals = Object.freeze([
    principal(identities.publisher, ["publisher"], required(environment, "TRUST_PUBLISHER_TOKEN")),
    principal(
      identities.distributionVerifier,
      ["distribution-verifier"],
      required(environment, "TRUST_DISTRIBUTION_VERIFIER_TOKEN"),
      publicKey,
    ),
    principal(identities.operator, ["operator"], required(environment, "TRUST_OPERATOR_TOKEN")),
    principal(identities.observer, ["observer"], required(environment, "TRUST_OBSERVER_TOKEN")),
    principal(identities.runtime, ["runtime"], required(environment, "TRUST_SKILL_RUNTIME_TOKEN")),
    principal(
      identities.process,
      ["runtime-process"],
      required(environment, "TRUST_SKILL_PROCESS_TOKEN"),
    ),
  ]);
  return Object.freeze({ identities, principals, privateKey, publicKey });
}

async function distributionVerifierPrivateKey(environment) {
  const path = required(environment, "TRUST_DISTRIBUTION_VERIFIER_PRIVATE_KEY_FILE");
  const pem = await readFile(path, "utf8");
  if (!pem.includes("PRIVATE KEY")) {
    throw new TypeError("TRUST verifier key file must contain one private key PEM");
  }
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== "ed25519") {
    throw new TypeError("TRUST verifier private key must be Ed25519");
  }
  return key;
}

function principal(identityValue, roles, token, publicKey) {
  return Object.freeze({
    identity: identityValue,
    roles: Object.freeze(roles),
    credentialSha256: `sha256:${createHash("sha256").update(bearer(token)).digest("hex")}`,
    ...(publicKey === undefined ? {} : { publicKey }),
  });
}

function bearer(value) {
  if (
    value.length < 8
    || value.length > 4_096
    || !/^[A-Za-z0-9._~+/=-]+$/.test(value)
  ) {
    throw new TypeError("server bearer tokens must be 8..4096 safe characters");
  }
  return value;
}

function identity(value) {
  const parsed = new URL(value);
  if (
    parsed.username !== ""
    || parsed.password !== ""
    || parsed.search !== ""
    || parsed.hash !== ""
  ) {
    throw new TypeError("registry identity must be an absolute credential-free URI");
  }
  return parsed.href;
}

function required(environment, name) {
  const value = environment[name];
  if (typeof value !== "string" || value === "" || value.includes("\0")) {
    throw new TypeError(`${name} is required and must not contain NUL`);
  }
  return value;
}
