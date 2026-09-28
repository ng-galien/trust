import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, open, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";

const PREFIX = "trust-sealed:v1:";
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export class CredentialSealingError extends Error {}

/**
 * Seals Environment credential values at rest with AES-256-GCM. The key lives in an owner-only file that is
 * never passed through the process environment; each envelope is bound to its Environment and name.
 */
export class CredentialSealer {
  #key: Promise<Buffer> | undefined;

  constructor(private readonly dependencies: { readonly credentialKeyFile: string }) {}

  static isSealed(stored: string): boolean {
    return stored.startsWith(PREFIX);
  }

  async seal(environment: string, name: string, value: string): Promise<string> {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", await this.#resolveKey(true), nonce);
    cipher.setAAD(binding(environment, name));
    const sealed = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return `${PREFIX}${Buffer.concat([nonce, cipher.getAuthTag(), sealed]).toString("base64")}`;
  }

  async open(environment: string, name: string, stored: string): Promise<string> {
    if (!CredentialSealer.isSealed(stored)) throw new CredentialSealingError("Stored credential is not sealed");
    const envelope = Buffer.from(stored.slice(PREFIX.length), "base64");
    if (envelope.length <= NONCE_BYTES + TAG_BYTES) throw new CredentialSealingError("Sealed credential is malformed");
    const decipher = createDecipheriv("aes-256-gcm", await this.#resolveKey(false), envelope.subarray(0, NONCE_BYTES));
    decipher.setAAD(binding(environment, name));
    decipher.setAuthTag(envelope.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES));
    try {
      return Buffer.concat([decipher.update(envelope.subarray(NONCE_BYTES + TAG_BYTES)), decipher.final()]).toString(
        "utf8",
      );
    } catch {
      throw new CredentialSealingError(
        `Credential "${environment}/${name}" cannot be opened with the configured credential key file`,
      );
    }
  }

  #resolveKey(create: boolean): Promise<Buffer> {
    this.#key ??= this.#loadKey(create);
    this.#key.catch(() => {
      this.#key = undefined;
    });
    return this.#key;
  }

  async #loadKey(create: boolean): Promise<Buffer> {
    const file = this.dependencies.credentialKeyFile;
    try {
      return await readKey(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!create) throw new CredentialSealingError(`Credential key file ${file} is missing`);
    }
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    try {
      const handle = await open(file, "wx", 0o600);
      try {
        await handle.writeFile(`${randomBytes(KEY_BYTES).toString("base64")}\n`);
      } finally {
        await handle.close();
      }
    } catch (error) {
      // A concurrent runtime sharing the same key file created it first.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    return readKey(file);
  }
}

async function readKey(file: string): Promise<Buffer> {
  const status = await stat(file);
  if (!status.isFile() || (status.mode & 0o077) !== 0)
    throw new CredentialSealingError(`Credential key file ${file} must be a regular file readable only by its owner`);
  const key = Buffer.from((await readFile(file, "utf8")).trim(), "base64");
  if (key.length !== KEY_BYTES)
    throw new CredentialSealingError(`Credential key file ${file} must hold ${KEY_BYTES} base64-encoded bytes`);
  return key;
}

const binding = (environment: string, name: string) => Buffer.from(`${environment}\0${name}`, "utf8");
