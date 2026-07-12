#!/usr/bin/env node
// HTTP bridge entrypoint: starts the remote conductor host (`conductors/http`) that lets a
// Tailscale-connected agent trigger `sparra` phases and role-runs on this machine, with the
// holdout wall enforced server-side. Runs the TypeScript via tsx (no build step).
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const server = resolve(here, "../conductors/http/server.ts");
const tsx = resolve(here, "../node_modules/.bin/tsx");

const res = spawnSync(tsx, [server, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(res.status ?? 1);
