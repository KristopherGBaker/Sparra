import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  isJudgeSandbox,
  describeRealBin,
  itRealBin,
  JUDGE_SANDBOX_ENV,
} from "./helpers/judgeEnv.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

// ── (a) pin the helper's run-vs-skip mode ────────────────────────────────────────────────────────

describe("judgeEnv helper — flag predicate pin (mutation-guarded)", () => {
  it("isJudgeSandbox: false without the flag, true with SPARRA_JUDGE_SANDBOX=1 (injected env)", () => {
    // The exported constant names the flag…
    expect(JUDGE_SANDBOX_ENV).toBe("SPARRA_JUDGE_SANDBOX");
    // …and the predicate is FALSE for absent / other / "0" values.
    expect(isJudgeSandbox({})).toBe(false);
    expect(isJudgeSandbox({ SOME_OTHER: "1" })).toBe(false);
    expect(isJudgeSandbox({ SPARRA_JUDGE_SANDBOX: "0" })).toBe(false);
    expect(isJudgeSandbox({ SPARRA_JUDGE_SANDBOX: "true" })).toBe(false);
    // FLAG-ON pin (a HARDCODED literal, not the imported constant, so neutering the helper's env-var
    // string — the mutation check — makes THIS assertion fail: the predicate reads the wrong key).
    expect(isJudgeSandbox({ SPARRA_JUDGE_SANDBOX: "1" })).toBe(true);
  });

  it("describeRealBin/itRealBin follow the predicate: run-mode off, skip-mode on", () => {
    // NB: `describe.skip` returns a FRESH chainable each access (no stable identity), so the skip-mode
    // pin asserts the wrapper is DISTINCT from the plain runner rather than a fragile identity compare.
    if (isJudgeSandbox()) {
      // flag-on pin (skip mode) — reached under `SPARRA_JUDGE_SANDBOX=1 npm test`.
      expect(describeRealBin).not.toBe(describe);
      expect(itRealBin).not.toBe(it);
    } else {
      // flag-off pin (run mode) — reached in CI / local / generator self-verify: BYTE-IDENTICAL to
      // the plain vitest runners (the stable base references), so the suites run unchanged.
      expect(describeRealBin).toBe(describe);
      expect(itRealBin).toBe(it);
    }
  });
});

// ── (b) behavioral META-TEST: identify affected suites by what they DO, not a name list ───────────

/**
 * A real child_process launch of a node subprocess (the packaged `bin/*.mjs` under `process.execPath`
 * or a `--import tsx` worker) — the exact thing that needs a Unix-socket LISTEN the judge sandbox
 * denies. Matches an actual CALL site (`spawnSync(process.execPath, …)`, `spawn("node", …)`), NOT a
 * path in a comment or an `expect(x).toBe(process.execPath)` assertion.
 */
const SPAWN_NODE_RE =
  /(?:spawnSync|spawn|execFileSync|execFile|fork)\s*\(\s*(?:process\.execPath|["']node["'])/;

/** Every affected suite consumes the single-source helper via this import substring. */
const HELPER_IMPORT_RE = /helpers\/judgeEnv/;

function listTestFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of fs.readdirSync(dir)) {
      if (name === "node_modules") continue;
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else if (name.endsWith(".test.ts")) out.push(p);
    }
  };
  walk(root);
  return out;
}

/** Scan BOTH Vitest roots and return repo-relative paths of files that spawn a real node subprocess. */
function detectRealBinSuites(): string[] {
  const files = [
    ...listTestFiles(path.join(repoRoot, "test")),
    ...listTestFiles(path.join(repoRoot, "conductors")),
  ];
  return files
    .filter((f) => SPAWN_NODE_RE.test(fs.readFileSync(f, "utf8")))
    .map((f) => path.relative(repoRoot, f).split(path.sep).join("/"))
    .sort();
}

describe("judgeEnv meta-test — every real-bin/tsx suite consumes the helper", () => {
  it("EVERY detected real-bin suite imports helpers/judgeEnv (no per-file env drift, no unguarded suite)", () => {
    const detected = detectRealBinSuites();
    const unguarded = detected.filter(
      (rel) => !HELPER_IMPORT_RE.test(fs.readFileSync(path.join(repoRoot, rel), "utf8")),
    );
    expect(unguarded, `real-bin suites missing the helper import: ${unguarded.join(", ")}`).toEqual([]);
  });

  it("detects the KNOWN affected suites (by behavior, across both roots)", () => {
    const detected = new Set(detectRealBinSuites());
    for (const rel of [
      "test/binSmoke.test.ts",
      "test/conduct.test.ts",
      "test/conductStatus.test.ts",
      "conductors/core/roleWorker.test.ts",
      "conductors/http/setup.test.ts",
      "conductors/http/packaging.test.ts",
    ]) {
      expect(detected.has(rel), `expected ${rel} to be detected as a real-bin suite`).toBe(true);
    }
  });

  it("does NOT flag mocked / path-only / non-node-spawn suites", () => {
    const detected = new Set(detectRealBinSuites());
    // spawn.test.ts: process.execPath only in an expect(); server.test.ts: bin path in a comment;
    // conductCore.test.ts: spawns `git`; exec.test.ts: spawn wrapper + string test-data; bridgeScript:
    // spawns bash/jq. None launches a real node bin/tsx subprocess.
    for (const rel of [
      "conductors/http/spawn.test.ts",
      "conductors/http/server.test.ts",
      "test/conductCore.test.ts",
      "test/exec.test.ts",
      "conductors/http/bridgeScript.test.ts",
    ]) {
      expect(detected.has(rel), `${rel} must NOT be flagged as a real-bin suite`).toBe(false);
    }
  });
});
