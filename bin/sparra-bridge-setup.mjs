#!/usr/bin/env node
// One-command lifecycle for the Sparra HTTP bridge LaunchAgent: `install [--rotate-token]` / `update`
// / `remove`. Auto-derives the plist (node/bin/cwd/log/config paths), generates + preserves a
// crypto-random Bearer token, seeds ~/.sparra/bridge.yaml once, and (re)loads it via launchctl —
// handing the token to you ONCE on stdout. Thin tsx spawner over `conductors/http/setup.ts`, which
// forwards argv to the single `runSetup` choke point. Runs the TypeScript via tsx (no build step).
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const setup = resolve(here, "../conductors/http/setup.ts");
const tsx = resolve(here, "../node_modules/.bin/tsx");

const res = spawnSync(tsx, [setup, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(res.status ?? 1);
