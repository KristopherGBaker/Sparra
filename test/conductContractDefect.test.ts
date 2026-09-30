import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  runUnitHybrid,
  detectContractDefect,
  strikeContractAssertion,
  resolveAssertionLineIndex,
  type ConductUnitDeps,
  type ConductRoundRecord,
} from "../src/conduct/unitRunner.ts";
import { JUDGMENT_OPTIONS, buildDecisionRequest, type JudgmentKind } from "../src/conduct/decision.ts";
import { defaultConfig, type RoleConfig } from "../src/config.ts";
import type { ParentSummary, RunRoleSpec } from "../conductors/core/index.ts";
import type { AssertionId } from "../src/build/types.ts";

// ─────────────────────────── fixtures ───────────────────────────
const role = defaultConfig().roles.generator as RoleConfig;

/** An evaluator ParentSummary failing exactly `failedIds` (empty = a clean pass). */
function ev(failedIds: number[], over: Partial<ParentSummary> = {}): ParentSummary {
  const pass = failedIds.length === 0;
  return {
    roleKind: "evaluator",
    verdict: pass ? "pass" : "fail",
    weightedTotal: pass ? 92 : 40,
    passThreshold: 70,
    blocking: failedIds.map((id) => `assertion ${id} failed`),
    failedAssertions: failedIds.map((id) => ({ id, pass: false, evidence: "e" })),
    verdictPath: "/v.md",
    sameModelGrade: false,
    costUsd: 0,
  } as ParentSummary;
}

/** A `ConductRoundRecord` whose evaluator fails exactly `failedIds`. */
function round(n: number, failedIds: number[]): ConductRoundRecord {
  return { round: n, evaluator: ev(failedIds), pivoted: false };
}

interface Ctl {
  /** The evaluator summary for the given 1-based eval call, told whether the poisoned assertion has
   *  already been struck (so a test can flip fail→pass on the re-eval). */
  evalFor: (evalCall: number, struck: boolean) => ParentSummary;
  decide?: ConductUnitDeps["decide"];
  judge?: ConductUnitDeps["judge"];
  maxRounds?: number;
  pivotAfterFailures?: number;
  generatorRole?: RoleConfig;
}

function makeDeps(ctl: Ctl): {
  deps: ConductUnitDeps;
  calls: {
    gen: number;
    eval: number;
    strike: { id: AssertionId; rationale: string }[];
    notes: { kind: JudgmentKind; answer: string; rationale?: string }[];
    judge: JudgmentKind[];
    generalize: number;
    order: string[];
  };
} {
  const calls = {
    gen: 0,
    eval: 0,
    strike: [] as { id: AssertionId; rationale: string }[],
    notes: [] as { kind: JudgmentKind; answer: string; rationale?: string }[],
    judge: [] as JudgmentKind[],
    generalize: 0,
    order: [] as string[],
  };
  let struck = false;
  const genSpec = { kind: "gen" } as unknown as RunRoleSpec;
  const evalSpec = { kind: "eval" } as unknown as RunRoleSpec;
  const baseJudge: ConductUnitDeps["judge"] =
    ctl.judge ?? (async () => ({ answer: "abandon", source: "auto-deterministic", via: "auto" }));
  const deps: ConductUnitDeps = {
    runRole: async (spec) => {
      const kind = (spec as unknown as { kind: string }).kind;
      if (kind === "gen") {
        calls.gen += 1;
        calls.order.push("gen");
        return { roleKind: "generator", filesChanged: 1 } as ParentSummary;
      }
      calls.eval += 1;
      calls.order.push("eval");
      return ctl.evalFor(calls.eval, struck);
    },
    specs: {
      generatorSpecFor: () => genSpec,
      evaluatorSpec: () => evalSpec,
      contractGeneratorSpec: {} as RunRoleSpec,
      contractEvaluatorSpec: {} as RunRoleSpec,
    } as unknown as ConductUnitDeps["specs"],
    decide: ctl.decide ?? (() => "revise"),
    judge: async (kind, s) => {
      calls.judge.push(kind);
      return baseJudge(kind, s);
    },
    noteDecision: (kind, answer, _source, _via, rationale) => {
      calls.notes.push({ kind, answer, ...(rationale ? { rationale } : {}) });
    },
    writeGeneralizedBrief: async () => {
      calls.generalize += 1;
      calls.order.push("generalize");
      return "/g.md";
    },
    strikeAssertion: async (id, rationale) => {
      calls.strike.push({ id, rationale });
      calls.order.push("strike");
      struck = true;
    },
    recordDecisionLearning: () => {},
    recoveryCaps: { role },
    generatorRole: ctl.generatorRole ?? role,
    unit: "unit-001",
    contractMaxRounds: 2,
    maxRounds: ctl.maxRounds ?? 3,
    pivotAfterFailures: ctl.pivotAfterFailures ?? 1,
    requireCrossModel: false,
    passThreshold: 70,
    borderlineMargin: 5,
    resumeContract: { agreed: true, forced: false },
  };
  return { deps, calls };
}

// ─────────────────────────── assertion 1 + 2: detection ───────────────────────────
describe("detectContractDefect — signature detection (assertions 1 + 2)", () => {
  it("1a positive: same id fails EVERY round, final round isolates it → poisoned id", () => {
    const rounds = [round(1, [3]), round(2, [3]), round(3, [3])];
    expect(detectContractDefect(rounds)).toBe(3);
  });

  it("1b positive: earlier round fails poisoned PLUS another id, final fails ONLY poisoned → still classified", () => {
    const rounds = [round(1, [3, 5]), round(2, [3, 7]), round(3, [3])];
    expect(detectContractDefect(rounds)).toBe(3);
  });

  it("2a negative: multiple distinct failing ids in the FINAL round → not the signature", () => {
    const rounds = [round(1, [3]), round(2, [3]), round(3, [3, 5])];
    expect(detectContractDefect(rounds)).toBeUndefined();
  });

  it("2b negative: the failing id DIFFERS across rounds → not the signature", () => {
    const rounds = [round(1, [3]), round(2, [5]), round(3, [5])];
    expect(detectContractDefect(rounds)).toBeUndefined();
  });

  it("2c negative: a completed round where that id PASSED (absent from its failed set) → not the signature", () => {
    const rounds = [round(1, [3]), round(2, [4]), round(3, [3])];
    expect(detectContractDefect(rounds)).toBeUndefined();
  });

  it("negative: an empty round list → undefined", () => {
    expect(detectContractDefect([])).toBeUndefined();
  });
});

// ─────────────────────────── assertion 3: decision-kind plumbing ───────────────────────────
describe("contract-defect decision kind — options/default + request plumbing (assertion 3)", () => {
  it("options include strike-assertion, pivot, abandon with strike-assertion as default", () => {
    expect(JUDGMENT_OPTIONS["contract-defect"]).toEqual({
      options: ["strike-assertion", "pivot", "abandon"],
      default: "strike-assertion",
    });
  });

  it("buildDecisionRequest surfaces the poisoned assertion id(s) as holdout-safe context", () => {
    const req = buildDecisionRequest({
      seq: 1,
      unit: "unit-001",
      kind: "contract-defect",
      nowMs: 0,
      timeoutSec: 1800,
      summary: ev([4]),
    });
    expect(req.kind).toBe("contract-defect");
    expect(req.options).toEqual(["strike-assertion", "pivot", "abandon"]);
    expect(req.default).toBe("strike-assertion");
    expect(req.context?.failedAssertions).toBe("4");
  });
});

// ─────────────────────────── assertion 4: surgical strike rewrite + fail-closed ───────────────────────────
describe("resolveAssertionLineIndex — resolves the poisoned line across forms, else -1", () => {
  it("numbered list: resolves by explicit ordinal", () => {
    const lines = "## Assertions\n\n1. a\n2. b\n3. c\n".split("\n");
    expect(resolveAssertionLineIndex(lines, 2)).toBe(3); // the `2. b` line
  });
  it("unnumbered bullets: resolves by 1-based POSITION", () => {
    const lines = "## Assertions\n\n- first live requirement\n- second live requirement\n".split("\n");
    expect(resolveAssertionLineIndex(lines, 1)).toBe(2);
    expect(resolveAssertionLineIndex(lines, 2)).toBe(3);
  });
  it("fully-numbered list with no matching ordinal → -1 (never accidental positional)", () => {
    const lines = "## Assertions\n\n1. a\n2. b\n3. c\n".split("\n");
    expect(resolveAssertionLineIndex(lines, 99)).toBe(-1);
  });
  it("unnumbered bullets, position out of range → -1", () => {
    const lines = "## Assertions\n\n- one\n- two\n".split("\n");
    expect(resolveAssertionLineIndex(lines, 99)).toBe(-1);
  });
});

describe("strikeContractAssertion — surgical, inert rewrite (assertion 4)", () => {
  it("numbered contract: marks ONLY the poisoned assertion inert, other assertions byte-unchanged, records id + rationale", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strike-"));
    try {
      const file = path.join(dir, "contract.md");
      const original =
        "# Contract\n\n## Assertions\n\n" +
        "1. First requirement stays exactly as written.\n" +
        "2. Second requirement is the poisoned one.\n" +
        "3. Third requirement stays exactly as written.\n";
      fs.writeFileSync(file, original);
      await strikeContractAssertion(file, 2, "failed every round while all else passed");
      const out = fs.readFileSync(file, "utf8");

      // Other assertions are byte-for-byte unchanged (still open with their plain numbered form).
      expect(out).toContain("\n1. First requirement stays exactly as written.\n");
      expect(out).toContain("\n3. Third requirement stays exactly as written.\n");
      // The poisoned line is DEACTIVATED — no longer a plain gradeable `2.` opener; struck marker prefixed.
      expect(out).not.toContain("\n2. Second requirement is the poisoned one.\n");
      expect(out).toContain("~~[STRUCK #2 — contract-defect; INERT, do NOT grade]~~ 2. Second requirement is the poisoned one.");
      // The struck id + rationale are preserved as an inert annotation.
      expect(out).toContain("## Struck assertions (contract-defect)");
      expect(out).toContain("#2 — STRUCK: failed every round while all else passed");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("UNNUMBERED-bullet contract: the struck requirement is verifiably INERT afterward (no longer a live bullet)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strike-"));
    try {
      const file = path.join(dir, "contract.md");
      const original =
        "# Contract\n\n## Assertions\n\n" +
        "- first live requirement\n" +
        "- second live requirement\n" +
        "- third live requirement\n";
      fs.writeFileSync(file, original);
      // The evaluator numbers unnumbered bullets by position: assertion #1 = the first bullet.
      await strikeContractAssertion(file, 1, "unsatisfiable in judge env");
      const out = fs.readFileSync(file, "utf8");

      // The first bullet is no longer a plain live `- ` list item — it's struck/inert.
      expect(out).not.toContain("\n- first live requirement\n");
      expect(out).toContain("~~[STRUCK #1 — contract-defect; INERT, do NOT grade]~~ - first live requirement");
      // Sibling requirements remain fully live and unchanged.
      expect(out).toContain("\n- second live requirement\n");
      expect(out).toContain("\n- third live requirement\n");
      expect(out).toContain("#1 — STRUCK: unsatisfiable in judge env");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("FAILS CLOSED on an unresolvable id: throws, writes NOTHING (no false annotation)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strike-"));
    try {
      const file = path.join(dir, "contract.md");
      const original = "# Contract\n\n## Assertions\n\n1. a\n2. b\n3. c\n";
      fs.writeFileSync(file, original);
      await expect(strikeContractAssertion(file, 99, "no such assertion")).rejects.toThrow(/could not be resolved/);
      // The contract is left EXACTLY as written — no strike marker, no annotation.
      const out = fs.readFileSync(file, "utf8");
      expect(out).toBe(original);
      expect(out).not.toContain("STRUCK");
      expect(out).not.toContain("Struck assertions");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("FAILS CLOSED on a missing contract file: throws, writes nothing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strike-"));
    try {
      const file = path.join(dir, "contract.md");
      await expect(strikeContractAssertion(file, 3, "why")).rejects.toThrow(/failing closed/);
      expect(fs.existsSync(file)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────── assertion 5: strike → re-eval recovery ───────────────────────────
describe("strike-assertion recovery flow — re-evaluate the existing artifact (assertion 5)", () => {
  it("pass branch: passing re-eval reaches the normal accept path, NO generator call before the re-eval", async () => {
    // decide never pivots (revise on fail), so exhaustion is reached at loop end without a 2nd pivot.
    const { deps, calls } = makeDeps({
      evalFor: (_n, struck) => ev(struck ? [] : [3]),
      decide: (s) => (s.verdict === "pass" ? "accept" : "revise"),
      judge: async () => ({ answer: "strike-assertion", source: "auto-deterministic", via: "auto" }),
      maxRounds: 2,
    });
    const res = await runUnitHybrid(deps);
    expect(res.outcome).toBe("accepted");
    // The contract-defect decision was surfaced (not a generic unit-exhausted).
    expect(calls.judge).toContain("contract-defect");
    expect(calls.judge).not.toContain("unit-exhausted");
    // Exactly one strike, of the poisoned id.
    expect(calls.strike).toHaveLength(1);
    expect(calls.strike[0]!.id).toBe(3);
    // The strike is immediately followed by an EVAL — never a generator run in between.
    const strikeAt = calls.order.indexOf("strike");
    expect(strikeAt).toBeGreaterThanOrEqual(0);
    expect(calls.order[strikeAt + 1]).toBe("eval");
    expect(calls.order.slice(strikeAt).includes("gen")).toBe(false);
  });

  it("fail branch: failing re-eval reaches the normal failure handling (still exhausted), NO generator before re-eval", async () => {
    const { deps, calls } = makeDeps({
      evalFor: () => ev([3]), // stays failing even after the strike
      decide: () => "revise",
      judge: async () => ({ answer: "strike-assertion", source: "auto-deterministic", via: "auto" }),
      maxRounds: 2,
    });
    const res = await runUnitHybrid(deps);
    expect(res.outcome).toBe("exhausted");
    expect(calls.strike).toHaveLength(1);
    const strikeAt = calls.order.indexOf("strike");
    expect(calls.order[strikeAt + 1]).toBe("eval");
    expect(calls.order.slice(strikeAt).includes("gen")).toBe(false);
  });

  it("abandon answer terminates the unit without a strike", async () => {
    const { deps, calls } = makeDeps({
      evalFor: () => ev([3]),
      decide: () => "revise",
      judge: async () => ({ answer: "abandon", source: "auto-deterministic", via: "auto" }),
      maxRounds: 2,
    });
    const res = await runUnitHybrid(deps);
    expect(res.outcome).toBe("abandoned");
    expect(calls.strike).toHaveLength(0);
  });

  it("pivot answer falls through to the plain exhausted terminal (no strike)", async () => {
    const { deps, calls } = makeDeps({
      evalFor: () => ev([3]),
      decide: () => "revise",
      judge: async () => ({ answer: "pivot", source: "auto-deterministic", via: "auto" }),
      maxRounds: 2,
    });
    const res = await runUnitHybrid(deps);
    expect(res.outcome).toBe("exhausted");
    expect(calls.strike).toHaveLength(0);
  });

  it("fail-closed: a strike that cannot deactivate the assertion surfaces an error and NEVER re-evaluates", async () => {
    const { deps, calls } = makeDeps({
      evalFor: () => ev([3]),
      decide: () => "revise",
      judge: async () => ({ answer: "strike-assertion", source: "auto-deterministic", via: "auto" }),
      maxRounds: 2,
    });
    // The real strike helper fails closed by throwing when the id can't be resolved; model that here
    // (still recording the attempt so we can prove the strike was reached before it failed closed).
    deps.strikeAssertion = async (id, rationale) => {
      calls.strike.push({ id, rationale });
      throw new Error("strike-assertion: could not be resolved — failing closed");
    };
    await expect(runUnitHybrid(deps)).rejects.toThrow(/failing closed/);
    // The strike was attempted (and failed closed) …
    expect(calls.strike).toHaveLength(1);
    // … but NO 3rd (re-eval) ran after it — only the two build rounds evaluated.
    expect(calls.eval).toBe(2);
  });
});

// ─────────────────────────── assertion 6: deterministic 2nd-pivot preference ───────────────────────────
describe("auto-deterministic 2nd-pivot path — strike-assertion vs generalize-spec (assertion 6)", () => {
  it("signature HOLDS → prefers strike-assertion (no generalized brief written)", async () => {
    // decide pivots on every fail → the 2nd pivot's deterministic generalize-spec branch is reached.
    const { deps, calls } = makeDeps({
      evalFor: (_n, struck) => ev(struck ? [] : [3]),
      decide: (s) => (s.verdict === "pass" ? "accept" : "pivot"),
      maxRounds: 5,
    });
    const res = await runUnitHybrid(deps);
    expect(res.outcome).toBe("accepted");
    expect(calls.strike).toHaveLength(1);
    expect(calls.strike[0]!.id).toBe(3);
    expect(calls.generalize).toBe(0); // strike PREFERRED over generalize-spec
    // The deterministic decision was noted as contract-defect / strike-assertion.
    const note = calls.notes.find((n) => n.kind === "contract-defect");
    expect(note?.answer).toBe("strike-assertion");
    expect(note?.rationale).toContain("#3");
  });

  it("signature ABSENT → still selects generalize-spec (unchanged), never strikes", async () => {
    // Different failing id each round → no contract-defect signature at the 2nd pivot.
    let r = 0;
    const { deps, calls } = makeDeps({
      evalFor: () => {
        r += 1;
        return ev([r]); // 1, 2, 3, … — always a distinct failing id
      },
      decide: () => "pivot",
      judge: async () => ({ answer: "pivot", source: "auto-deterministic", via: "auto" }),
      maxRounds: 3,
    });
    const res = await runUnitHybrid(deps);
    expect(res.outcome).toBe("exhausted");
    expect(calls.strike).toHaveLength(0);
    expect(calls.generalize).toBeGreaterThanOrEqual(1); // generalize-spec still selected
    expect(calls.notes.some((n) => n.answer === "generalize-spec")).toBe(true);
  });
});

// ─────────────── non-signature loop-end path is UNCHANGED (assertion 2 unchanged-flow) ───────────────
describe("non-signature unit-exhausted path is unchanged (assertion 2)", () => {
  it("distinct failing ids at exhaustion → surfaces unit-exhausted (never contract-defect)", async () => {
    let r = 0;
    const { deps, calls } = makeDeps({
      evalFor: () => {
        r += 1;
        return ev([r, r + 10]); // multiple distinct ids, differ each round
      },
      decide: () => "revise", // never pivot → reach loop end with no 2nd pivot
      judge: async () => ({ answer: "abandon", source: "auto-deterministic", via: "auto" }),
      maxRounds: 2,
    });
    const res = await runUnitHybrid(deps);
    expect(res.outcome).toBe("abandoned");
    expect(calls.judge).toContain("unit-exhausted");
    expect(calls.judge).not.toContain("contract-defect");
    expect(calls.strike).toHaveLength(0);
  });
});

// ─────────────────────────── non-numeric assertion ids ("6b", "H4") ───────────────────────────
describe("non-numeric assertion ids — detection + fail-closed strike", () => {
  const evIds = (failedIds: (number | string)[]): ParentSummary =>
    ({
      roleKind: "evaluator",
      verdict: "fail",
      weightedTotal: 40,
      passThreshold: 70,
      blocking: [],
      failedAssertions: failedIds.map((id) => ({ id, pass: false, evidence: "e" })),
      verdictPath: "/v.md",
    }) as unknown as ParentSummary;
  const roundIds = (n: number, ids: (number | string)[]): ConductRoundRecord => ({ round: n, evaluator: evIds(ids), pivoted: false });

  it("detectContractDefect returns \"6b\" when it failed every round and was the final round's only failure", () => {
    const rounds = [roundIds(1, ["6b", 2]), roundIds(2, ["6b"]), roundIds(3, ["6b"])];
    expect(detectContractDefect(rounds)).toBe("6b");
  });

  it("a different string id in an earlier round breaks the signature", () => {
    const rounds = [roundIds(1, ["6a"]), roundIds(2, ["6b"]), roundIds(3, ["6b"])];
    expect(detectContractDefect(rounds)).toBeUndefined();
  });

  it("resolveAssertionLineIndex → -1 for a non-numeric id, even with unnumbered bullets", () => {
    const lines = "## Assertions\n\n- one\n- two\n".split("\n");
    expect(resolveAssertionLineIndex(lines, "6b")).toBe(-1);
    expect(resolveAssertionLineIndex(lines, "H4")).toBe(-1);
  });

  it("strikeContractAssertion with \"6b\" fails closed and leaves the contract byte-identical", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strike-"));
    try {
      const file = path.join(dir, "contract.md");
      const original = "# Contract\n\n## Assertions\n\n1. a\n2. b\n6. c\n";
      fs.writeFileSync(file, original);
      await expect(strikeContractAssertion(file, "6b", "why")).rejects.toThrow(/could not be resolved/);
      expect(fs.readFileSync(file, "utf8")).toBe(original);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
