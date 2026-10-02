import path from "node:path";
import { type Response, Router } from "express";
import { ExtensionError, type ExtensionHost } from "../extensions/host.js";
import { confinedPath } from "../extensions/manifest.js";

/** Installed browser bundles are public code; extension data never passes this router. */
export function createExtensionAssetsHttpHandler(extensionHost: ExtensionHost): Router {
  const router = Router();
  router.use((request, response, next) => {
    const [, id, encodedPath] = /^\/([a-z][a-z0-9-]*)\/assets\/(.+)$/u.exec(request.path) ?? [];
    if (id === undefined || encodedPath === undefined) {
      next();
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("allow", "GET, HEAD");
      response.status(405).end();
      return;
    }
    const serve = async () => {
      const extension = extensionHost.get(id);
      if (!extension.installation.ui) throw new Error("No installed browser bundle");
      const relative = decodeURIComponent(encodedPath);
      const parts = relative.split("/");
      if (
        !relative ||
        relative.includes("\\") ||
        parts.some(
          (part) =>
            !part || part.startsWith(".") || /^(?:server|backend|src|source|data|node_modules)(?:[.-]|$)/iu.test(part),
        )
      )
        throw new Error("Invalid asset path");
      const browserFormats = new Set([
        ".js",
        ".mjs",
        ".css",
        ".woff",
        ".woff2",
        ".ttf",
        ".otf",
        ".eot",
        ".png",
        ".jpg",
        ".jpeg",
        ".gif",
        ".webp",
        ".avif",
        ".svg",
        ".ico",
      ]);
      if (relative !== "preview-version.json" && !browserFormats.has(path.extname(relative).toLowerCase()))
        throw new Error("Not a browser asset");
      if (parts.length === 1 && relative !== extension.installation.ui.entry && relative !== "preview-version.json")
        throw new Error("Not a browser entry");
      const file = await confinedPath(extension.installation.ui.assets, relative);
      response.set({ "cache-control": "public, max-age=0, must-revalidate", "x-content-type-options": "nosniff" });
      response.sendFile(file, (error) => {
        if (error) assetNotFound(response, "extension-asset-not-found");
      });
    };
    void serve().catch((error: unknown) =>
      assetNotFound(
        response,
        error instanceof ExtensionError && error.code === "extension-not-found"
          ? "extension-not-found"
          : "extension-asset-not-found",
      ),
    );
  });
  return router;
}

/** Same JSON error shape as the other extension routes; the cause of a refused asset is not disclosed. */
function assetNotFound(response: Response, code: "extension-not-found" | "extension-asset-not-found"): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  response.removeHeader("cache-control");
  response.status(404).json({ error: { code, message: "Extension asset not found" } });
}
