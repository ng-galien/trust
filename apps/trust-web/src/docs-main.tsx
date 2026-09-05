import { TrustDocumentation } from "@trust/ui/docs";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

const root = document.getElementById("root");
if (!root) throw new Error("TRUST documentation root is unavailable");

createRoot(root).render(
  <StrictMode>
    <TrustDocumentation />
  </StrictMode>,
);
