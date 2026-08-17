import { i18next } from "../../i18n/index.js";
import type { CompiledOperation } from "../../types.js";

/* Classification of Operations.
   Derived in the UI until the Operation grammar accepts classification tags
   (proposed: `@family:<slug>` and `@nature:observe|act` — today rejected as outside the closed grammar).
   Everything below is a presentation rule, not a contract. */

export type Nature = "observe" | "act";

export interface Family {
  id: string;
  label: string;
  domains: string[];
}

export const families: Family[] = [
  { id: "software-delivery", get label() { return i18next.t("operations.families.softwareDelivery"); }, domains: ["git", "maven", "docker", "kind", "kubernetes", "karate", "playwright", "jira", "telemetry", "file", "http"] },
  { id: "healthcare", get label() { return i18next.t("operations.families.healthcare"); }, domains: ["healthcare"] },
  { id: "aviation", get label() { return i18next.t("operations.families.aviation"); }, domains: ["aviation"] },
  { id: "food", get label() { return i18next.t("operations.families.food"); }, domains: ["food"] },
];

export const otherFamily: Family = { id: "other", get label() { return i18next.t("operations.families.other"); }, domains: [] };

export function familyOf(domain: string, operation?: CompiledOperation): Family {
  const tagged = operation?.classification?.family?.[0];
  if (tagged) return families.find((family) => family.id === tagged) ?? { id: tagged, label: labelOf(tagged), domains: [] };
  return families.find((family) => family.domains.includes(domain)) ?? otherFamily;
}

function labelOf(slug: string) {
  return slug.replace(/-/g, " ").replace(/^\w/, (letter) => letter.toUpperCase());
}

const actingSuffixes = /(release|build|record|deploy|load|promote|rotat|publish|write|create|apply|push|delete|remove|start|stop|restart|admission)/i;

/** Observe: reads a system without changing it. Act: performs an effect (POST, build, release…). */
export function natureOf(operation: CompiledOperation): Nature {
  const tagged = operation.classification?.nature?.[0];
  if (tagged === "observe" || tagged === "act") return tagged;
  const posts = operation.steps.some((step) => step.type === "http" && (step.http as { method?: string } | undefined)?.method === "POST");
  const action = operation.operation.split(".").slice(1).join(".");
  return posts || actingSuffixes.test(action) ? "act" : "observe";
}

export function natureLabel(nature: Nature): string {
  return nature === "observe" ? i18next.t("operations.natures.observe") : i18next.t("operations.natures.act");
}
