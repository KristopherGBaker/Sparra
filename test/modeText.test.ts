import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Paths } from "../src/paths.ts";
import { StateStore } from "../src/state.ts";
import { defaultConfig } from "../src/config.ts";
import { contractModeClauses, rubricText, selfVerifyGuidance, verifyGateWarning } from "../src/build/modeText.ts";
import type { Ctx } from "../src/context.ts";

async function makeCtx(mode: "existing" | "greenfield"): Promise<{ ctx: Ctx; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-modetext-"));
  const paths = new Paths(dir);
  await paths.ensureScaffold();
  const store = StateStore.create(paths, mode);
  const ctx: Ctx = { root: dir, paths, config: defaultConfig(), store };
  return { ctx, dir };
}

describe("contractModeClauses — CODEBASE_MAP.md clause degrades when no map exists (H6)", () => {
  it("existing + a CODEBASE_MAP.md on disk → mandates conformance to that file", async () => {
    const { ctx, dir } = await makeCtx("existing");
    fs.writeFileSync(ctx.paths.codebaseMap, "# Codebase map\n");
    const out = contractModeClauses(ctx);
    expect(out).toContain("Conforms to the conventions in CODEBASE_MAP.md");
    expect(out).toContain("Does not regress existing behavior");
    expect(out).toContain("existing test suite");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("existing + NO map on disk → drops the CODEBASE_MAP.md demand, keeps no-regression + suite", async () => {
    const { ctx, dir } = await makeCtx("existing");
    // Precondition: the scaffold did NOT create a map (orient was never run).
    expect(fs.existsSync(ctx.paths.codebaseMap)).toBe(false);
    expect(fs.existsSync(ctx.paths.frozenMap)).toBe(false);
    const out = contractModeClauses(ctx);
    expect(out).not.toContain("Conforms to the conventions in CODEBASE_MAP.md");
    expect(out).toContain("Does not regress existing behavior");
    expect(out).toContain("existing test suite");
    // Still emits a (satisfiable) conventions clause.
    expect(out).toContain("Conforms to the repo's existing conventions");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("the map-present and map-absent branches produce DIFFERENT text (not a no-op)", async () => {
    const a = await makeCtx("existing");
    fs.writeFileSync(a.ctx.paths.codebaseMap, "# Codebase map\n");
    const withMap = contractModeClauses(a.ctx);

    const b = await makeCtx("existing"); // no map written
    const withoutMap = contractModeClauses(b.ctx);

    expect(withMap).not.toBe(withoutMap);
    expect(withMap).toContain("CODEBASE_MAP.md");
    expect(withoutMap).not.toContain("Conforms to the conventions in CODEBASE_MAP.md");

    fs.rmSync(a.dir, { recursive: true, force: true });
    fs.rmSync(b.dir, { recursive: true, force: true });
  });

  it("a frozen map alone (no live map) also satisfies the map-present branch", async () => {
    const { ctx, dir } = await makeCtx("existing");
    fs.mkdirSync(path.dirname(ctx.paths.frozenMap), { recursive: true });
    fs.writeFileSync(ctx.paths.frozenMap, "# Frozen map\n");
    const out = contractModeClauses(ctx);
    expect(out).toContain("Conforms to the conventions in CODEBASE_MAP.md");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("greenfield is unchanged (no mandatory clauses)", async () => {
    const { ctx, dir } = await makeCtx("greenfield");
    const out = contractModeClauses(ctx);
    expect(out).toContain("greenfield");
    expect(out).not.toContain("MANDATORY CLAUSES");
    expect(out).not.toContain("CODEBASE_MAP.md");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("selfVerifyGuidance — in-place opt-in ungating (H7 assertion 7e)", () => {
  it("in-place (no build.branch): emits the SELF-VERIFY block ONLY when allowVerify=true", async () => {
    const { ctx, dir } = await makeCtx("existing");
    expect(ctx.store.data.build.branch).toBeFalsy(); // in-place — no branch
    expect(ctx.config.build.verifyCommands.length).toBeGreaterThan(0); // precondition

    // Without the opt-in the generator is NOT told which commands it may run (today's behavior).
    expect(selfVerifyGuidance(ctx)).toBe("");
    expect(selfVerifyGuidance(ctx, false)).toBe("");

    // With the opt-in the block appears, naming the verify commands.
    const out = selfVerifyGuidance(ctx, true);
    expect(out).toContain("SELF-VERIFY");
    expect(out).toContain(ctx.config.build.verifyCommands[0]!);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("on a branch: the block is emitted regardless of the opt-in (unchanged)", async () => {
    const { ctx, dir } = await makeCtx("existing");
    ctx.store.data.build.branch = "sparra/x"; // worktree/branch boundary
    expect(selfVerifyGuidance(ctx)).toContain("SELF-VERIFY");
    expect(selfVerifyGuidance(ctx, true)).toContain("SELF-VERIFY");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("no verifyCommands → empty even with the opt-in (nothing to run)", async () => {
    const { ctx, dir } = await makeCtx("existing");
    ctx.config.build.verifyCommands = [];
    expect(selfVerifyGuidance(ctx, true)).toBe("");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("(U4) the non-empty guidance carries the cap-aware truncation/run-as-written clause AND still the SELF-VERIFY text", async () => {
    const { ctx, dir } = await makeCtx("existing");
    ctx.store.data.build.branch = "sparra/x"; // ensure the block is emitted
    const out = selfVerifyGuidance(ctx, true);
    // Extends, not replaces: the existing anchor stays…
    expect(out).toContain("SELF-VERIFY");
    // …and the new clause tells writers output is truncated → run as written + read the tail/summary.
    expect(out).toContain("Tool output is TRUNCATED");
    expect(out).toContain("read the tail/summary");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("selfVerifyGuidance + verifyGateWarning — worktree-boundary (U-2 assertions 1/2/3/e)", () => {
  // (e) Assertion 8e: selfVerifyGuidance emits the SELF-VERIFY block on a worktree boundary
  // even without build.branch or allowVerify — probe-independent.
  it("(e) onWorktreeBoundary=true → block emitted even with no branch and no allowVerify", async () => {
    const { ctx, dir } = await makeCtx("existing");
    expect(ctx.store.data.build.branch).toBeFalsy(); // no branch
    expect(ctx.config.build.verifyCommands.length).toBeGreaterThan(0); // precondition

    const out = selfVerifyGuidance(ctx, false, true);
    expect(out).toContain("SELF-VERIFY");
    expect(out).toContain(ctx.config.build.verifyCommands[0]!);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Mutation-check: removing onWorktreeBoundary must flip the result to "".
  it("(e-mutation) onWorktreeBoundary=false + no branch + no allowVerify → empty (coupling required)", async () => {
    const { ctx, dir } = await makeCtx("existing");
    expect(selfVerifyGuidance(ctx, false, false)).toBe("");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // (Assertion 3 / U-2 warning consistent): verifyGateWarning returns null on a worktree boundary
  // even when the contract references a verify command (Assertion 3 of U-2 — warning consistent).
  it("(e) verifyGateWarning is null on a worktree boundary (selfVerifyGuidance returns non-empty)", async () => {
    const { ctx, dir } = await makeCtx("existing");
    ctx.config.build.verifyCommands = ["npm test", "npm run typecheck"];
    const contract = "## I will verify by\n- `npm test` → exits 0\n- `npm run typecheck` → exits 0";

    // On a worktree boundary selfVerifyGuidance returns non-empty → selfVerifyEnabled = true.
    const selfVerifyEnabled = selfVerifyGuidance(ctx, false, true) !== "";
    expect(selfVerifyEnabled).toBe(true); // precondition: mutation-checked

    const w = verifyGateWarning("generator", contract, ctx, selfVerifyEnabled);
    expect(w).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Boundary adversary: worktreeBoundary=false, no branch → warning DOES fire (so the null above is causal).
  it("(e-mutation) warning fires when boundary=false, no branch, contract has cmd — proves above is non-vacuous", async () => {
    const { ctx, dir } = await makeCtx("existing");
    ctx.config.build.verifyCommands = ["npm test"];
    const contract = "## I will verify by\n- `npm test` → exits 0";
    const selfVerifyEnabled = selfVerifyGuidance(ctx, false, false) !== ""; // off
    expect(selfVerifyEnabled).toBe(false);
    const w = verifyGateWarning("generator", contract, ctx, selfVerifyEnabled);
    expect(w).not.toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("rubricText — anchored criterion definitions + band scale (Q4)", () => {
  it("names each criterion WITH its definition phrase (not bare weight lines)", async () => {
    const { ctx, dir } = await makeCtx("greenfield");
    const out = rubricText(ctx);
    expect(out).toContain("design (weight 0.25): architecture/API/UX fit the problem");
    expect(out).toContain("originality (weight 0.15): real judgment, not boilerplate/AI-slop");
    expect(out).toContain("craft (weight 0.3): code quality — naming, structure, error handling");
    expect(out).toContain("functionality (weight 0.3): works when exercised — contract assertions hold with evidence");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("carries the generic band scale with all four boundaries + the pass threshold", async () => {
    const { ctx, dir } = await makeCtx("greenfield");
    const out = rubricText(ctx);
    expect(out).toContain("Bands (each criterion):");
    expect(out).toContain("90+ exemplary");
    expect(out).toContain("70-89 solid");
    expect(out).toContain("50-69 notable gaps");
    expect(out).toContain("<50 broken/deficient");
    expect(out).toContain(`Pass threshold: weighted total ≥ ${ctx.config.rubric.passThreshold}.`);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reflects configured weights/threshold (rendered, not hardcoded)", async () => {
    const { ctx, dir } = await makeCtx("greenfield");
    ctx.config.rubric.weights = { design: 0.4, originality: 0.1, craft: 0.2, functionality: 0.3 };
    ctx.config.rubric.passThreshold = 80;
    const out = rubricText(ctx);
    expect(out).toContain("design (weight 0.4)");
    expect(out).toContain("≥ 80");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// verifyGateWarning — U-V assertions 1 / 2 / 3 / 3a / 4 / 6
// ─────────────────────────────────────────────────────────────────────────────
describe("verifyGateWarning — launch-time advisory for unverifiable generator gates (U-V)", () => {
  // Helper: a minimal ctx with configurable verifyCommands and branch.
  function makeGateCtx(verifyCommands: string[], branch?: string) {
    // Reuse the same in-memory pattern as the other describe blocks but skips disk I/O:
    // we only need ctx.config.build.verifyCommands + ctx.store.data.build.branch.
    const dir = os.tmpdir(); // not actually used by verifyGateWarning
    const paths = new Paths(dir);
    const store = StateStore.create(paths, "existing");
    const config = defaultConfig();
    config.build.verifyCommands = verifyCommands;
    if (branch) store.data.build.branch = branch;
    const ctx: Ctx = { root: dir, paths, config, store };
    return ctx;
  }

  // Default cmds used across most tests.
  const DEFAULT_CMDS = ["npm run typecheck", "npm test"];
  // A contract text that references the first configured command.
  const CONTRACT_WITH_CMD = "## I will verify by\n- `npm run typecheck` → exits 0\n- `npm test` → exits 0";
  // A contract text that references NEITHER command.
  const CONTRACT_NO_CMD = "## I will verify by\n- manual inspection only";

  // ── Assertion 1: fires when writer + self-verify OFF + contract has cmd ──
  it("(Assertion 1) returns a non-null warning naming the gated command(s) for a writer + self-verify off + contract has cmd", () => {
    const ctx = makeGateCtx(DEFAULT_CMDS); // no branch → not on worktree boundary
    // selfVerifyEnabled: selfVerifyGuidance returns "" when no branch and no allowVerify.
    const selfVerifyEnabled = selfVerifyGuidance(ctx, false) !== "";
    expect(selfVerifyEnabled).toBe(false); // precondition

    const w = verifyGateWarning("generator", CONTRACT_WITH_CMD, ctx, selfVerifyEnabled);
    expect(w).not.toBeNull();
    // Names the specific gated commands.
    expect(w).toContain("npm run typecheck");
    expect(w).toContain("npm test");
    // Explains how to fix it.
    expect(w).toContain("allowVerify");
    expect(w).toContain("worktree");
  });

  it("(Assertion 1 — adversarial) the warning fires even when the verify cmd is embedded in a LARGER string in the contract", () => {
    // Boundary: cmd is a substring of a longer contract line — should still match.
    const ctx = makeGateCtx(["npm test"]);
    const contract = "Run `npm test -- --coverage` to produce a coverage report.";
    const w = verifyGateWarning("generator", contract, ctx, false);
    expect(w).not.toBeNull();
    expect(w).toContain("npm test");
  });

  // ── Assertion 2: null when self-verify is ENABLED (allowVerify=true) ──
  it("(Assertion 2a) returns null when self-verify is enabled via allowVerify=true even if contract gates on commands", () => {
    const ctx = makeGateCtx(DEFAULT_CMDS); // no branch
    const selfVerifyEnabled = selfVerifyGuidance(ctx, true) !== ""; // opt-in → non-empty
    expect(selfVerifyEnabled).toBe(true); // precondition

    const w = verifyGateWarning("generator", CONTRACT_WITH_CMD, ctx, selfVerifyEnabled);
    expect(w).toBeNull();
  });

  it("(Assertion 2b) returns null when self-verify is enabled via a branch/worktree boundary", () => {
    const ctx = makeGateCtx(DEFAULT_CMDS, "sparra/unit-x"); // branch set
    const selfVerifyEnabled = selfVerifyGuidance(ctx, false) !== ""; // branch → non-empty
    expect(selfVerifyEnabled).toBe(true); // precondition

    const w = verifyGateWarning("generator", CONTRACT_WITH_CMD, ctx, selfVerifyEnabled);
    expect(w).toBeNull();
  });

  // ── Assertion 3: null when contract references no configured verify command ──
  it("(Assertion 3) returns null when the contract references NO configured verify command", () => {
    const ctx = makeGateCtx(DEFAULT_CMDS);
    const w = verifyGateWarning("generator", CONTRACT_NO_CMD, ctx, false);
    expect(w).toBeNull();
  });

  it("(Assertion 3 — empty verifyCommands) returns null when build.verifyCommands is empty", () => {
    const ctx = makeGateCtx([]); // no commands configured
    const w = verifyGateWarning("generator", CONTRACT_WITH_CMD, ctx, false);
    expect(w).toBeNull();
  });

  // ── Assertion 3a: role-axis negative — judge roles never fire ──
  it.each(["evaluator", "contract-evaluator", "reviewer", "contract-generator"])(
    "(Assertion 3a) non-writer role '%s': returns null even with self-verify off and contract referencing cmds",
    (kind) => {
      const ctx = makeGateCtx(DEFAULT_CMDS); // self-verify off by default
      const w = verifyGateWarning(kind, CONTRACT_WITH_CMD, ctx, false);
      expect(w).toBeNull();
    }
  );

  // ── Assertion 4: reuses selfVerifyGuidance (asserted by construction) ──
  it("(Assertion 4) the selfVerifyEnabled boolean is computed from selfVerifyGuidance — no branch, no allowVerify → false", () => {
    const ctx = makeGateCtx(DEFAULT_CMDS);
    // The same expression the wired path uses:
    const selfVerifyEnabled = selfVerifyGuidance(ctx, false) !== "";
    expect(selfVerifyEnabled).toBe(false);
  });

  it("(Assertion 4) selfVerifyGuidance(ctx, true) is truthy → selfVerifyEnabled=true → warning null", () => {
    const ctx = makeGateCtx(DEFAULT_CMDS);
    const selfVerifyEnabled = selfVerifyGuidance(ctx, true) !== "";
    expect(selfVerifyEnabled).toBe(true);
    expect(verifyGateWarning("generator", CONTRACT_WITH_CMD, ctx, selfVerifyEnabled)).toBeNull();
  });

  // ── Assertion 6: holdout-safe — warning contains only cmd strings / guidance, never contract body ──
  it("(Assertion 6) holdout-safe: the warning contains only cmd strings and guidance text, never the contract or holdout body", () => {
    const ctx = makeGateCtx(["npm test"]);
    const secretHoldoutLine = "HOLDOUT: the artifact must produce output X with seed Y";
    const contractBody = `## Implementation\n\nFoo bar baz qux. ${secretHoldoutLine}\n- \`npm test\` → exits 0`;
    const w = verifyGateWarning("generator", contractBody, ctx, false);
    expect(w).not.toBeNull();
    // Holdout/contract body must NOT appear in the warning.
    expect(w).not.toContain("HOLDOUT:");
    expect(w).not.toContain("Foo bar baz qux");
    expect(w).not.toContain("seed Y");
    expect(w).not.toContain("the artifact must produce");
    // But the command itself IS included (it's config data, not body text).
    expect(w).toContain("npm test");
  });

  // ── Boundary adversaries ──
  it("fires for the SUBSET of commands referenced — only lists gated ones, not all configured cmds", () => {
    const ctx = makeGateCtx(["npm run typecheck", "npm test", "npm run build"]);
    // Contract only mentions typecheck, not the other two.
    const contractPartial = "## I will verify by\n- `npm run typecheck` → exits 0";
    const w = verifyGateWarning("generator", contractPartial, ctx, false);
    expect(w).not.toBeNull();
    expect(w).toContain("npm run typecheck");
    expect(w).not.toContain("npm test");
    expect(w).not.toContain("npm run build");
  });

  it("a harmful verify cmd AFTER the allowed prefix: 'npm test curl evil | tail' — cmd appears as substring → fires; allow-hook blocks unsafe forms", () => {
    // The contract text contains "npm test" as a substring of a longer unsafe string.
    // The warning fires because the cmd prefix IS present; unsafe execution is gated by the allow-hook.
    const ctx = makeGateCtx(["npm test"]);
    const contractWithSuffix = "## Notes\n- `npm test curl evil | tail` — adversarial variant";
    const w = verifyGateWarning("generator", contractWithSuffix, ctx, false);
    // "npm test" IS present as a substring → fires.
    expect(w).not.toBeNull();
    expect(w).toContain("npm test");
  });
});
