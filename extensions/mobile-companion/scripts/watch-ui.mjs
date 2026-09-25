import { spawn } from "node:child_process";
import { copyFile, cp, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const extension = fileURLToPath(new URL("../", import.meta.url));
const stage = path.join(extension, ".preview-build");
const live = path.join(extension, "dist");
let running = false;
let pending = false;
let previous;

function build() {
  if (running) {
    pending = true;
    return;
  }
  running = true;
  const child = spawn(
    "npm",
    ["run", "build:ui", "--workspace=@trust-extension/mobile-companion", "--", "--outDir", ".preview-build"],
    {
      cwd: extension,
      env: { ...process.env, VITE_MOBILE_PREVIEW: "1" },
      stdio: "inherit",
    },
  );
  child.on("exit", async (code) => {
    if (code === 0) {
      try {
        await mkdir(path.join(live, "assets"), { recursive: true });
        await cp(path.join(stage, "assets"), path.join(live, "assets"), { recursive: true, force: true });
        for (const name of await readdir(stage)) {
          if (name === "assets" || name === "remoteEntry.js") continue;
          await cp(path.join(stage, name), path.join(live, name), { recursive: true, force: true });
        }
        await copyFile(path.join(stage, "remoteEntry.js"), path.join(live, "remoteEntry.next.js"));
        await rename(path.join(live, "remoteEntry.next.js"), path.join(live, "remoteEntry.js"));
        await writeFile(path.join(live, "preview-version.next.json"), JSON.stringify({ revision: Date.now() }));
        await rename(path.join(live, "preview-version.next.json"), path.join(live, "preview-version.json"));
        await rm(stage, { recursive: true, force: true });
      } catch (error) {
        console.error("Mobile preview publish failed:", error);
        code = 1;
      }
    }
    running = false;
    console.log(`Mobile preview build ${code === 0 ? "ready" : `failed (${code})`}.`);
    if (pending) {
      pending = false;
      build();
    }
  });
}

async function signature() {
  const files = (await readdir(path.join(extension, "ui"), { recursive: true })).map((name) =>
    path.join(extension, "ui", name),
  );
  files.push(path.join(extension, "vite.config.ts"));
  const values = await Promise.all(
    files.sort().map(async (file) => {
      const info = await stat(file);
      return [file, info.mtimeMs, info.size];
    }),
  );
  return JSON.stringify(values);
}

previous = await signature();
setInterval(async () => {
  try {
    const current = await signature();
    if (current !== previous) {
      previous = current;
      build();
    }
  } catch (error) {
    console.error(error);
  }
}, 2000);
build();
