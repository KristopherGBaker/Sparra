import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Paths } from "../src/paths.ts";
import type { SparraState } from "../src/state.ts";

export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

export function readState(paths: Paths): SparraState | null {
  try {
    return JSON.parse(fs.readFileSync(paths.state, "utf8")) as SparraState;
  } catch {
    return null;
  }
}

/** Newest trace markdown file in the active build run (for the live activity tail). */
export function activeTraceFile(paths: Paths, state: SparraState | null): string | null {
  const runId = state?.build.runId;
  if (!runId) return null;
  const dir = paths.traceDir(runId);
  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    return files[0] ? path.join(dir, files[0].f) : null;
  } catch {
    return null;
  }
}

export function tailLines(file: string, n: number): string[] {
  try {
    return fs.readFileSync(file, "utf8").trimEnd().split("\n").slice(-n);
  } catch {
    return [];
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const sparraBin = path.resolve(here, "..", "bin", "sparra.mjs");

export interface ChildHandle {
  kill: () => void;
}

/** Spawn a Sparra CLI command as a child and stream its (ANSI-stripped) output. */
export function spawnSparra(root: string, args: string[], onLine: (line: string) => void, onExit: (code: number) => void): ChildHandle {
  const child = spawn("node", [sparraBin, ...args, "--root", root], { env: { ...process.env, NO_COLOR: "1" } });
  let buf = "";
  const handle = (chunk: Buffer) => {
    buf += chunk.toString();
    const parts = buf.split("\n");
    buf = parts.pop() ?? "";
    for (const p of parts) onLine(stripAnsi(p));
  };
  child.stdout.on("data", handle);
  child.stderr.on("data", handle);
  child.on("close", (code) => {
    if (buf) onLine(stripAnsi(buf));
    onExit(code ?? 0);
  });
  return { kill: () => child.kill("SIGTERM") };
}

export { Paths };
