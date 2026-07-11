import { spawn } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { roleWorkerMain } from "./roleWorker.ts";

const CANARY = "SPARRA_HOLDOUT_CANARY_DO_NOT_LEAK";
const STUB = fileURLToPath(new URL("./__fixtures__/stub-sparra.mjs", import.meta.url));
const WORKER = fileURLToPath(new URL("./roleWorker.ts", import.meta.url));

describe("roleWorker", () => {
  it("roleWorkerMain returns summary JSON with no canary", async () => {
    process.env.SPARRA_BIN = STUB;
    try {
      const json = await roleWorkerMain(["--", "role", "run", "--kind", "evaluator"]);
      const summary = JSON.parse(json);
      expect(summary.verdict).toBe("pass");
      expect(json).not.toContain(CANARY);
      expect(json).not.toContain("resultText");
    } finally {
      delete process.env.SPARRA_BIN;
    }
  });

  it("spawned as a real child process, writes ONLY the redacted summary to stdout", async () => {
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", WORKER, "--", "role", "run", "--kind", "evaluator"], {
        env: { ...process.env, SPARRA_BIN: STUB },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (c) => (out += c));
      child.stderr.on("data", (c) => (err += c));
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}: ${err}`))));
    });
    expect(stdout).not.toContain(CANARY);
    const summary = JSON.parse(stdout.trim());
    expect(summary.verdict).toBe("pass");
    expect(summary.resultText).toBeUndefined();
    expect(summary.traceDir).toBeUndefined();
  });
});
