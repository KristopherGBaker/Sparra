import { describe, expect, it, vi } from "vitest";

import type { ParentSummary, RunRoleSpec } from "../core/index.ts";
import {
  buildRunUnitConfig,
  parseLoopCommandArgs,
  registerSparraLoopCommand,
  renderUnitReport,
} from "./loopCommand.ts";

/**
 * `conductors/pi/loopCommand.test.ts` — exercises the Pi-free `/sparra-loop` command logic: arg
 * parsing, the `RunUnitConfig` builder (contract-evaluator + cross-model generator/evaluator specs),
 * the holdout-safe report renderer, and the registered command handler over a scripted `runRole` and
 * a minimal fake `pi` host. This module imports `loopCommand.ts`, which is Pi TYPE-ONLY, so no Pi
 * runtime is ever loaded here.
 */

const CANARY = "SPARRA_HOLDOUT_CANARY_DO_NOT_LEAK";

/** Minimal required fields for a well-formed ParentSummary, so hand-built fixtures below don't need
 *  risky `as ParentSummary` casts over partial objects. Mirrors `loop.test.ts`/`contract.test.ts`. */
function baseSummary(overrides: Partial<ParentSummary>): ParentSummary {
  return {
    roleKind: "generator",
    backend: "stub",
    model: "stub-model-1",
    ok: true,
    errors: [],
    tokens: 0,
    costUsd: 0,
    ...overrides,
  };
}

describe("parseLoopCommandArgs", () => {
  it("parses a valid full invocation", () => {
    const parsed = parseLoopCommandArgs(
      "--brief b.md --contract c.md --holdout h.md --generator-model sonnet " +
        "--evaluator-model opus --backend claude --max-rounds 4 --contract-rounds 2 " +
        "--proceed-if-not-agreed",
    );
    expect(parsed.brief).toBe("b.md");
    expect(parsed.contract).toBe("c.md");
    expect(parsed.holdout).toBe("h.md");
    expect(parsed.maxRounds).toBe(4);
    expect(parsed.contractRounds).toBe(2);
    expect(parsed.proceedIfNotAgreed).toBe(true);
  });

  it("throws when --brief is missing", () => {
    expect(() => parseLoopCommandArgs("--contract c.md")).toThrow(/usage/);
  });

  it("throws when --contract is missing", () => {
    expect(() => parseLoopCommandArgs("--brief b.md")).toThrow(/usage/);
  });

  it("defaults contractRounds to undefined (buildRunUnitConfig applies the default of 3) and proceedIfNotAgreed to false", () => {
    const parsed = parseLoopCommandArgs("--brief b.md --contract c.md");
    expect(parsed.contractRounds).toBeUndefined();
    expect(parsed.proceedIfNotAgreed).toBe(false);
  });

  it("parses --contract-rounds", () => {
    const parsed = parseLoopCommandArgs("--brief b.md --contract c.md --contract-rounds 5");
    expect(parsed.contractRounds).toBe(5);
  });

  it("throws on a non-positive --contract-rounds", () => {
    expect(() => parseLoopCommandArgs("--brief b.md --contract c.md --contract-rounds 0")).toThrow(
      /--contract-rounds must be a positive integer/,
    );
  });

  it("throws on a non-numeric --contract-rounds", () => {
    expect(() => parseLoopCommandArgs("--brief b.md --contract c.md --contract-rounds abc")).toThrow(
      /--contract-rounds must be a positive integer/,
    );
  });

  it("--proceed-if-not-agreed sets the flag without consuming a value", () => {
    const parsed = parseLoopCommandArgs("--brief b.md --contract c.md --proceed-if-not-agreed");
    expect(parsed.proceedIfNotAgreed).toBe(true);
    expect(parsed.brief).toBe("b.md");
    expect(parsed.contract).toBe("c.md");
  });
});

describe("buildRunUnitConfig", () => {
  const parsed = parseLoopCommandArgs("--brief b.md --contract c.md");
  const critiqueDir = "/tmp/sparra-loop-test-critiques";

  it("generator and evaluator specs are cross-model by default", () => {
    const config = buildRunUnitConfig(parsed, { critiqueDir });
    const genArgs = config.generatorSpec({ round: 1, feedback: [], pivoting: false }).args;
    const evalArgs = config.evaluatorSpec({ round: 1, feedback: [], pivoting: false }).args;
    const genModelIdx = genArgs.indexOf("--model");
    const evalModelIdx = evalArgs.indexOf("--model");
    expect(genArgs[genModelIdx + 1]).toBe("sonnet");
    expect(evalArgs[evalModelIdx + 1]).toBe("opus");
    expect(genArgs[genModelIdx + 1]).not.toBe(evalArgs[evalModelIdx + 1]);
  });

  it("contractEvaluatorSpec round 1: --kind contract-evaluator, --out round-1 path, no --prior-critique", () => {
    const config = buildRunUnitConfig(parsed, { critiqueDir });
    const spec: RunRoleSpec = config.contract.contractEvaluatorSpec({ round: 1, priorCritiquePaths: [] });
    expect(spec.args).toContain("contract-evaluator");
    expect(spec.args).toContain("--out");
    expect(spec.args[spec.args.indexOf("--out") + 1]).toBe(
      `${critiqueDir}/sparra-loop-critique-round-1.md`,
    );
    expect(spec.args).not.toContain("--prior-critique");
    // runs on the evaluator model, not the generator model
    expect(spec.args[spec.args.indexOf("--model") + 1]).toBe("opus");
  });

  it("contractEvaluatorSpec round 2 threads priorCritiquePaths as --prior-critique", () => {
    const config = buildRunUnitConfig(parsed, { critiqueDir });
    const spec = config.contract.contractEvaluatorSpec({
      round: 2,
      priorCritiquePaths: ["/c/a.md"],
    });
    const idx = spec.args.indexOf("--prior-critique");
    expect(idx).toBeGreaterThan(-1);
    expect(spec.args[idx + 1]).toBe("/c/a.md");
    expect(spec.args[spec.args.indexOf("--out") + 1]).toBe(
      `${critiqueDir}/sparra-loop-critique-round-2.md`,
    );
  });

  it("contractEvaluatorSpec appends one --prior-critique per prior path, in order", () => {
    const config = buildRunUnitConfig(parsed, { critiqueDir });
    const spec = config.contract.contractEvaluatorSpec({
      round: 3,
      priorCritiquePaths: ["/c/a.md", "/c/b.md"],
    });
    const priorFlags = spec.args
      .map((tok, i) => (tok === "--prior-critique" ? spec.args[i + 1] : undefined))
      .filter((v): v is string => v !== undefined);
    expect(priorFlags).toEqual(["/c/a.md", "/c/b.md"]);
  });

  it("evaluatorSpec includes --holdout only when a holdout was given", () => {
    const withoutHoldout = buildRunUnitConfig(parsed, { critiqueDir });
    expect(withoutHoldout.evaluatorSpec({ round: 1, feedback: [], pivoting: false }).args).not.toContain(
      "--holdout",
    );

    const withHoldout = parseLoopCommandArgs("--brief b.md --contract c.md --holdout h.md");
    const config = buildRunUnitConfig(withHoldout, { critiqueDir });
    const evalArgs = config.evaluatorSpec({ round: 1, feedback: [], pivoting: false }).args;
    expect(evalArgs[evalArgs.indexOf("--holdout") + 1]).toBe("h.md");
  });

  it("a revision generatorSpec includes --brief-text carrying prior feedback", () => {
    const config = buildRunUnitConfig(parsed, { critiqueDir });
    const args = config.generatorSpec({ round: 2, feedback: ["x"], pivoting: false }).args;
    expect(args).toContain("--brief-text");
    const text = args[args.indexOf("--brief-text") + 1];
    expect(text).toContain("Round 2");
    expect(text).toContain("x");
  });

  it("contract.maxRounds defaults to 3 and honors parsed.contractRounds", () => {
    const defaultConfig = buildRunUnitConfig(parsed, { critiqueDir });
    expect(defaultConfig.contract.maxRounds).toBe(3);

    const overridden = parseLoopCommandArgs("--brief b.md --contract c.md --contract-rounds 7");
    const config = buildRunUnitConfig(overridden, { critiqueDir });
    expect(config.contract.maxRounds).toBe(7);
  });

  it("proceedIfNotAgreed is threaded from parsed args", () => {
    const parsedProceed = parseLoopCommandArgs("--brief b.md --contract c.md --proceed-if-not-agreed");
    const config = buildRunUnitConfig(parsedProceed, { critiqueDir });
    expect(config.proceedIfNotAgreed).toBe(true);
  });
});

describe("renderUnitReport", () => {
  it("is holdout-safe: no resultText/traceDir/canary in the rendered report", () => {
    const report = renderUnitReport({
      outcome: "accepted",
      contract: {
        agreed: true,
        rounds: [
          {
            round: 1,
            agreed: true,
            evaluator: baseSummary({
              roleKind: "contract-evaluator",
              contractAgreed: true,
              blocking: [`safe critique line mentioning nothing secret, definitely not ${CANARY}`],
            }),
          },
        ],
        critiquePaths: [],
      },
      cycle: {
        outcome: "accepted",
        rounds: [
          {
            round: 1,
            generator: baseSummary({ roleKind: "generator" }),
            evaluator: baseSummary({
              roleKind: "evaluator",
              verdict: "pass",
              weightedTotal: 90,
              passThreshold: 75,
              sameModelGrade: false,
            }),
            decision: "accept",
          },
        ],
      },
    });
    expect(report).not.toContain("resultText");
    expect(report).not.toContain("traceDir");
    expect(report).not.toContain(CANARY);
    expect(report).toContain("contract round 1: agreed=true");
    expect(report).toContain("contract: agreed after 1 round(s)");
    expect(report).toContain("round 1: accept");
    expect(report).toContain("outcome: accepted");
  });

  it("reports contract-not-agreed with no cycle section", () => {
    const report = renderUnitReport({
      outcome: "contract-not-agreed",
      contract: {
        agreed: false,
        rounds: [
          { round: 1, agreed: false, evaluator: baseSummary({ contractAgreed: false, outPath: "/c/r1.md" }) },
          { round: 2, agreed: false, evaluator: baseSummary({ contractAgreed: false, outPath: "/c/r2.md" }) },
        ],
        critiquePaths: ["/c/r1.md", "/c/r2.md"],
      },
    });
    expect(report).toContain("contract round 1: agreed=false");
    expect(report).toContain("contract round 2: agreed=false");
    expect(report).toContain("contract: not-agreed after 2 round(s)");
    expect(report).toContain("outcome: contract-not-agreed");
    expect(report).not.toMatch(/^round \d+:/m);
  });
});

/** A minimal fake `pi` extension host: just enough of `ExtensionAPI` for
 *  `registerSparraLoopCommand` to register its command and for the test to invoke the captured
 *  handler directly, without ever loading the real Pi SDK. */
function fakePi() {
  const notifications: { message: string; type: string }[] = [];
  let handler: ((args: string, ctx: { ui: { notify: (m: string, t?: string) => void } }) => Promise<void>) | undefined;
  const pi = {
    registerCommand: (
      _name: string,
      options: { handler: (args: string, ctx: unknown) => Promise<void> },
    ) => {
      handler = options.handler as typeof handler;
    },
  };
  const ctx = { ui: { notify: (message: string, type = "info") => notifications.push({ message, type }) } };
  return {
    pi: pi as unknown as Parameters<typeof registerSparraLoopCommand>[0],
    ctx,
    notifications,
    invoke: (args: string) => {
      if (!handler) throw new Error("fakePi: no command was registered");
      return handler(args, ctx);
    },
  };
}

describe("registerSparraLoopCommand handler", () => {
  it("drives runUnit end-to-end: contract agrees, cycle accepts, holdout-safe report notified", async () => {
    const { pi, notifications, invoke } = fakePi();
    const seenKinds: string[] = [];
    const runRole = vi.fn(async (spec: RunRoleSpec) => {
      if (spec.args.includes("contract-evaluator")) {
        seenKinds.push("contract-evaluator");
        return baseSummary({
          roleKind: "contract-evaluator",
          contractAgreed: true,
          outPath: "/c/r.md",
        });
      }
      if (spec.args.includes("generator")) {
        seenKinds.push("generator");
        return baseSummary({ roleKind: "generator", filesChanged: 1 });
      }
      // evaluatorSpec's args are ["eval", ".", ...] — no "--kind evaluator"
      seenKinds.push("evaluator");
      return baseSummary({
        roleKind: "evaluator",
        verdict: "pass",
        weightedTotal: 90,
        passThreshold: 75,
        sameModelGrade: false,
      });
    });

    registerSparraLoopCommand(pi, { runRole });
    await invoke("--brief b.md --contract c.md");

    expect(seenKinds).toEqual(["contract-evaluator", "generator", "evaluator"]);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.type).toBe("info");
    expect(notifications[0]!.message).toContain("outcome: accepted");
    expect(notifications[0]!.message).toContain("contract: agreed after 1 round(s)");
    const serialized = JSON.stringify(notifications);
    expect(serialized).not.toContain("resultText");
    expect(serialized).not.toContain("traceDir");
    expect(serialized).not.toContain(CANARY);
  });

  it("short-circuits on a not-agreed contract without --proceed-if-not-agreed: generator/evaluator never run", async () => {
    const { pi, notifications, invoke } = fakePi();
    const runRole = vi.fn(async (spec: RunRoleSpec) => {
      if (spec.args.includes("contract-evaluator")) {
        return baseSummary({ roleKind: "contract-evaluator", contractAgreed: false, outPath: "/c/r1.md" });
      }
      throw new Error(`unexpected role run with args ${JSON.stringify(spec.args)}`);
    });

    registerSparraLoopCommand(pi, { runRole });
    await invoke("--brief b.md --contract c.md --contract-rounds 1");

    // Only the single contract-evaluator round ran — the generator/evaluator branch would have
    // thrown above if reached.
    expect(runRole).toHaveBeenCalledTimes(1);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.type).toBe("warning");
    expect(notifications[0]!.message).toContain("outcome: contract-not-agreed");
    expect(notifications[0]!.message).toContain("contract: not-agreed after 1 round(s)");
  });

  it("notifies a warning and never calls runRole on a bad-arg parse error", async () => {
    const { pi, notifications, invoke } = fakePi();
    const runRole = vi.fn(async () => {
      throw new Error("should never be called");
    });

    registerSparraLoopCommand(pi, { runRole });
    await invoke("--brief b.md");

    expect(runRole).not.toHaveBeenCalled();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.type).toBe("error");
    expect(notifications[0]!.message).toMatch(/usage/);
  });
});
