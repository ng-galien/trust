import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { TrustDocumentation } from "@trust/ui/docs";

const root = document.getElementById("root");
if (!root) throw new Error("TRUST documentation root is unavailable");

createRoot(root).render(
  <StrictMode>
    <TrustDocumentation />
  </StrictMode>,
);
