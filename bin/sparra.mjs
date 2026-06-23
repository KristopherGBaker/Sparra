#!/usr/bin/env node
// Thin launcher so `sparra` works as an installed bin without a build step.
// It shells out to tsx to run the TypeScript CLI directly.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, "../src/cli.ts");
const tsx = resolve(here, "../node_modules/.bin/tsx");

const res = spawnSync(tsx, [cli, ...process.argv.slice(2)], {
  stdio: "inherit",
});
process.exit(res.status ?? 1);
