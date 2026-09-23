import type { CompiledOperation } from "@trust/operation";
import { matchOperationStep } from "@trust/operation/match";
import { i18next } from "../../i18n/index.js";

/* Catalog classification uses editable tags when present, then falls back to the
   published definition and name. These are presentation rules, not Runner inputs. */

export type Nature = "observe" | "act";

export interface Family {
  id: string;
  label: string;
  domains: string[];
}

export const families: Family[] = [
  {
    id: "software-delivery",
    get label() {
      return i18next.t("operations.families.softwareDelivery");
    },
    domains: [
      "git",
      "maven",
      "docker",
      "kind",
      "kubernetes",
      "karate",
      "playwright",
      "jira",
      "telemetry",
      "file",
      "http",
    ],
  },
  {
    id: "healthcare",
    get label() {
      return i18next.t("operations.families.healthcare");
    },
    domains: ["healthcare"],
  },
  {
    id: "aviation",
    get label() {
      return i18next.t("operations.families.aviation");
    },
    domains: ["aviation"],
  },
  {
    id: "food",
    get label() {
      return i18next.t("operations.families.food");
    },
    domains: ["food"],
  },
];

export const otherFamily: Family = {
  id: "other",
  get label() {
    return i18next.t("operations.families.other");
  },
  domains: [],
};

export function familyOf(domain: string, operation?: CompiledOperation, tags?: readonly string[]): Family {
  const tagged =
    tags === undefined
      ? operation?.classification?.family?.[0]
      : tags.find((tag) => tag.startsWith("family:"))?.slice("family:".length);
  if (tagged)
    return families.find((family) => family.id === tagged) ?? { id: tagged, label: labelOf(tagged), domains: [] };
  return families.find((family) => family.domains.includes(domain)) ?? otherFamily;
}

function labelOf(slug: string) {
  return slug.replace(/-/g, " ").replace(/^\w/, (letter) => letter.toUpperCase());
}

const actingSuffixes =
  /(release|build|record|deploy|load|promote|rotat|publish|write|create|apply|push|delete|remove|start|stop|restart|admission)/i;

/** Observe: reads a system without changing it. Act: performs an effect (POST, build, release…). */
export function natureOf(operation: CompiledOperation): Nature {
  const tagged = operation.classification?.nature?.[0];
  if (tagged === "observe" || tagged === "act") return tagged;
  const posts = operation.steps.some((step) =>
    matchOperationStep(step, {
      http: (value) => value.http.method === "POST",
      shell: () => false,
      "file-read": () => false,
      postgresql: () => false,
    }),
  );
  const action = operation.operation.split(".").slice(1).join(".");
  return posts || actingSuffixes.test(action) ? "act" : "observe";
}

export function natureLabel(nature: Nature): string {
  return nature === "observe" ? i18next.t("operations.natures.observe") : i18next.t("operations.natures.act");
}
