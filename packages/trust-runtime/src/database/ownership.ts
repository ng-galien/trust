import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, stat, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export class DatabaseOwnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseOwnershipError";
  }
}

/** Fail closed after a crash. A stale marker is never automatically stolen or removed. */
export async function ownEmbeddedDirectory(directory: string): Promise<{
  readonly directory: string;
  release(): Promise<void>;
}> {
  if (!directory.trim() || directory === ":memory:") {
    throw new Error("PGlite storage requires an explicit local data directory");
  }
  await mkdir(resolve(directory), { recursive: true });
  const canonicalDirectory = await realpath(resolve(directory));
  const identity = await stat(canonicalDirectory, { bigint: true });
  const parent = await realpath(dirname(canonicalDirectory));
  // Filesystem identity also covers case aliases on a case-insensitive volume.
  // initdb requires an empty data directory; keep the marker in its canonical parent.
  const key = createHash("sha256").update(`${identity.dev}:${identity.ino}`).digest("hex");
  const marker = join(parent, `.trust-runtime-owner-${key}`);
  const contents = JSON.stringify({
    token: randomUUID(),
    pid: process.pid,
    startedAt: new Date().toISOString(),
    directory: canonicalDirectory,
    device: identity.dev.toString(),
    inode: identity.ino.toString(),
  });
  const handle = await open(marker, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
    throw new DatabaseOwnershipError(
      "PGlite database already has a runtime ownership marker. Stop its owner before reopening. " +
        `After a crash, verify that no runtime owns this directory and explicitly remove ${marker}; no automatic takeover is performed.`,
    );
  });
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } catch (error) {
    // A partial marker remains fail-closed when its durable identity is uncertain.
    await handle.close();
    throw error;
  }
  await handle.close();
  let released = false;
  return {
    directory: canonicalDirectory,
    async release() {
      if (released) return;
      if ((await readFile(marker, "utf8")) !== contents) {
        throw new DatabaseOwnershipError("PGlite ownership marker changed; refusing to remove another owner's marker");
      }
      await unlink(marker);
      released = true;
    },
  };
}
