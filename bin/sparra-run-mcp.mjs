#!/usr/bin/env node
// MCP server entrypoint: exposes the `run_role` tool to a Claude Code session so the
// conductor can run Sparra roles (generator/evaluator/…) on a chosen backend with the
// holdout wall enforced server-side. Runs the TypeScript via tsx (no build step).
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const server = resolve(here, "../src/mcp/runRoleServer.ts");
const tsx = resolve(here, "../node_modules/.bin/tsx");

const res = spawnSync(tsx, [server, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(res.status ?? 1);
