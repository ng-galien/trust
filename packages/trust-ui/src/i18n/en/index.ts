import { common } from "./common.js";
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

/* English dictionary — one module per area, merged here. Keys are `area.section.name`;
   plurals use i18next suffixes (`_one` / `_other`), interpolation uses `{{value}}`. */

export const en = {
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
} as const;
