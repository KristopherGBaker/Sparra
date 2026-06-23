#!/usr/bin/env node
// Launcher for the Sparra Ink TUI.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "../tui/index.tsx");
const tsx = resolve(here, "../node_modules/.bin/tsx");

const res = spawnSync(tsx, [entry, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(res.status ?? 1);
