#!/usr/bin/env node

import { runTrialCli } from "../src/cli/trial.js";

process.exitCode = await runTrialCli();
