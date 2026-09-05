import * as monaco from "@codingame/monaco-vscode-editor-api";
import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router";

import { initializeTrustMonaco } from "./monaco-stack.js";

/** Translate LSP resource identities into host routes, never executable commands. */
export function EditorResourceNavigation() {
  const navigate = useNavigate();
  const location = useLocation();
  useEffect(() => {
    let active = true;
    let registration: monaco.IDisposable | undefined;
    void initializeTrustMonaco()
      .then(() => {
        if (!active) return;
        registration = monaco.editor.registerLinkOpener({
          open(resource) {
            if (resource.scheme !== "trust-resource") return false;
            // Consume malformed resource links rather than passing them to an external opener.
            try {
              // Monaco's default serialization encodes query separators (version= becomes
              // version%3D). Its decoded URI fields already preserve the semantic contract.
              const uri = new URL(resource.toString(true));
              const collection =
                uri.hostname === "operation" ? "operations" : uri.hostname === "procedure" ? "procedures" : undefined;
              const id = decodeURIComponent(uri.pathname.slice(1));
              const version = uri.searchParams.get("version");
              if (
                !collection ||
                !id ||
                id.includes("/") ||
                id === "." ||
                id === ".." ||
                !version ||
                uri.searchParams.getAll("version").length !== 1 ||
                [...uri.searchParams.keys()].some((key) => key !== "version") ||
                uri.username ||
                uri.password ||
                uri.port ||
                uri.hash
              )
                return true;
              const search = new URLSearchParams({ version, tab: "source" });
              void navigate(`/${collection}/${encodeURIComponent(id)}?${search}`, {
                state: { from: `${location.pathname}${location.search}` },
              });
            } catch {
              /* A malformed semantic reference is not a navigation target. */
            }
            return true;
          },
        });
      })
      .catch((error) => console.error("TRUST editor navigation initialization failed", error));
    return () => {
      active = false;
      registration?.dispose();
    };
  }, [navigate, location.pathname, location.search]);
  return null;
}
