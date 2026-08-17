import type { en } from "../en/index.js";
import type { Translation } from "../types.js";
import { common } from "./common.js";
import { docs } from "./docs.js";
import { environments } from "./environments.js";
import { history } from "./history.js";
import { operations } from "./operations.js";
import { overview } from "./overview.js";
import { plans } from "./plans.js";
import { procedures } from "./procedures.js";
import { settings } from "./settings.js";
import { shared } from "./shared.js";
import { shell } from "./shell.js";
import { ui } from "./ui.js";

/* French dictionary — same modules and keys as the English one (typed against it). */

export const fr: Translation<typeof en> = {
  common,
  shell,
  ui,
  shared,
  operations,
  procedures,
  plans,
  environments,
  history,
  overview,
  settings,
  docs,
};
