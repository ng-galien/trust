import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { TrustApplication } from "@trust/ui";

const root = document.getElementById("root");
if (!root) throw new Error("TRUST web root is unavailable");

createRoot(root).render(
  <StrictMode>
    <TrustApplication runtimeUrl="" />
  </StrictMode>,
);
