#!/usr/bin/env bun

import { runCli } from "../src/cli/run.js";

process.exitCode = await runCli();
