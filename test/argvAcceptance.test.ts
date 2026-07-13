import child_process from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { acceptArgv } from "./helpers/argvAcceptance.ts";
import { buildUnitRoleSpecs } from "../src/conduct/roleSpecs.ts";
import type { RoleConfig } from "../src/config.ts";
import type {
  ContractRoundContext,
  RoundContext,
  RunRoleSpec,
} from "../conductors/core/index.ts";
import { runSparraRoleForTool } from "../conductors/pi/roleRunner.ts";
import { buildRunUnitConfig, parseLoopCommandArgs } from "../conductors/pi/loopCommand.ts";
import { buildRoleSpec, buildUnitConfig } from "../conductors/http/handlers/conductor.ts";

/**
 * `test/argvAcceptance.test.ts` — proves every conduct spec builder's argv is ACCEPTED by the real
 * CLI parser + pre-model role-run validation layer, in-process and spend-free, via the seam in
 * `test/helpers/argvAcceptance.ts`. Includes the mutation-check for the historical missing-`--brief`
 * bug. Zero subprocess/model calls; the only FS writes are the revision-brief a builder legitimately
 * writes into a tmp dir.
 */

let tmp: string;
let briefPath: string;
let contractPath: string;
let holdoutPath: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "argv-accept-"));
  briefPath = path.join(tmp, "brief.md");
  contractPath = path.join(tmp, "contract.md");
  holdoutPath = path.join(tmp, "holdout.md");
  fs.writeFileSync(briefPath, "# Brief\nDo the thing.\n");
  fs.writeFileSync(contractPath, "# Contract\nAGREED\n");
  fs.writeFileSync(holdoutPath, "holdout assertions\n");
  round2 = { round: 2, feedback: ["fix the parser"], pivoting: false, priorVerdictPaths: [contractPath] };
  cround2 = { round: 2, priorCritiquePaths: [contractPath] };
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const role = (model: string, backend = "claude"): RoleConfig => ({ backend, model });

function specParams(overrides?: { holdoutPath?: string; budget?: number; maxTurns?: number }) {
  return {
    roles: {
      contractGenerator: role("sonnet"),
      contractEvaluator: role("opus"),
      generator: role("sonnet"),
      evaluator: role("opus"),
    },
    workspace: tmp,
    unitDir: tmp,
    briefPath,
    contractPath,
    unitWorktree: "unit-001",
    unitId: "unit-001",
    sparraBin: "/does/not/matter/sparra.mjs",
    ...overrides,
  };
}

const round1: RoundContext = { round: 1, feedback: [], pivoting: false };
const round2Pivot: RoundContext = { round: 2, feedback: ["try again"], pivoting: true };
const cround1: ContractRoundContext = { round: 1, priorCritiquePaths: [] };
// Path-bearing contexts are built in beforeAll — the fixture paths don't exist at module-eval time.
let round2: RoundContext;
let cround2: ContractRoundContext;

/** Assert an argv is accepted; on failure surface the seam's reason for a readable diagnostic. */
function expectAccepted(argv: string[], label: string): void {
  const res = acceptArgv(argv, { root: tmp });
  expect(res.accepted, `${label} should be ACCEPTED but was rejected: ${res.reason}`).toBe(true);
}

describe("seam — pure, in-process, spend-free (assertion 1)", () => {
  it("accepts a valid generator role-run argv (fixture brief/contract) with zero subprocess/FS writes", () => {
    const spawn = vi.spyOn(child_process, "spawn");
    const spawnSync = vi.spyOn(child_process, "spawnSync");
    const execFile = vi.spyOn(child_process, "execFile");
    const writeSync = vi.spyOn(fs, "writeFileSync");

    const res = acceptArgv(
      ["role", "run", "--kind", "generator", "--brief", briefPath, "--contract", contractPath, "--json"],
      { root: tmp },
    );

    expect(res.accepted).toBe(true);
    expect(res.kind).toBe("generator");
    expect(spawn).not.toHaveBeenCalled();
    expect(spawnSync).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
    expect(writeSync).not.toHaveBeenCalled();

    spawn.mockRestore();
    spawnSync.mockRestore();
    execFile.mockRestore();
    writeSync.mockRestore();
  });
});

describe("seam — contrasting negatives (assertion 2)", () => {
  it("rejects an invalid --kind", () => {
    const res = acceptArgv(["role", "run", "--kind", "bogus", "--brief", briefPath], { root: tmp });
    expect(res.accepted).toBe(false);
    expect(res.reason).toMatch(/--kind must be one of/);
  });

  it("rejects a contract-evaluator argv missing --brief/--brief-text (reason names the brief rule)", () => {
    const res = acceptArgv(
      ["role", "run", "--kind", "contract-evaluator", "--contract", contractPath, "--json"],
      { root: tmp },
    );
    expect(res.accepted).toBe(false);
    expect(res.reason).toMatch(/provide a brief/);
  });

  it("rejects an unsupported command shape (not `role run` / `eval`)", () => {
    const res = acceptArgv(["conduct", "do something"], { root: tmp });
    expect(res.accepted).toBe(false);
    expect(res.reason).toMatch(/unsupported command/);
  });
});

describe("seam — eval alias normalization shared with cli.ts (assertion 4)", () => {
  it("accepts `eval [dir] --contract … --json` as kind=evaluator with positional→workspace", () => {
    const res = acceptArgv(["eval", ".", "--contract", contractPath, "--json"], { root: tmp });
    expect(res.accepted).toBe(true);
    expect(res.kind).toBe("evaluator");
  });

  it("an evaluator via `eval` alias needs no brief (evaluator-exempt)", () => {
    const res = acceptArgv(["eval", tmp, "--json"], { root: tmp });
    expect(res.accepted).toBe(true);
    expect(res.kind).toBe("evaluator");
  });
});

describe("roleSpecs.ts — every builder variant accepted (assertion 6)", () => {
  let specs: ReturnType<typeof buildUnitRoleSpecs>;
  beforeAll(() => {
    specs = buildUnitRoleSpecs(specParams());
  });

  it("contract-generator fresh (round 1)", () => {
    expectAccepted(specs.contractGeneratorSpec(cround1).args, "contractGeneratorSpec fresh");
  });

  it("contract-generator revision (round 2, priorCritiquePaths non-empty)", () => {
    expectAccepted(specs.contractGeneratorSpec(cround2).args, "contractGeneratorSpec revision");
  });

  it("contract-evaluator (fresh + re-critique)", () => {
    expectAccepted(specs.contractEvaluatorSpec(cround1).args, "contractEvaluatorSpec fresh");
    expectAccepted(specs.contractEvaluatorSpec(cround2).args, "contractEvaluatorSpec re-critique");
  });

  it("generator (round 1 + round>1 with feedback)", () => {
    expectAccepted(specs.generatorSpec(round1).args, "generatorSpec r1");
    expectAccepted(specs.generatorSpec(round2).args, "generatorSpec r2 feedback");
  });

  it("generatorSpecFor escalation (explicit role + generalized brief override)", () => {
    const escalated = role("opus");
    expectAccepted(specs.generatorSpecFor(escalated, round2Pivot).args, "generatorSpecFor escalation");
    expectAccepted(
      specs.generatorSpecFor(escalated, round1, briefPath).args,
      "generatorSpecFor generalized-brief override",
    );
  });

  it("evaluator ± holdout ± prior-blocking ± caps", () => {
    // no holdout, no prior-blocking, no caps
    expectAccepted(specs.evaluatorSpec(round1).args, "evaluatorSpec bare");
    // prior-blocking (round 2 threads priorVerdictPaths → --prior-blocking)
    expectAccepted(specs.evaluatorSpec(round2).args, "evaluatorSpec prior-blocking");
    // holdout + caps
    const withHoldoutCaps = buildUnitRoleSpecs(
      specParams({ holdoutPath, budget: 0, maxTurns: 40 }),
    );
    expectAccepted(withHoldoutCaps.evaluatorSpec(round1).args, "evaluatorSpec holdout+caps");
    expectAccepted(withHoldoutCaps.evaluatorSpec(round2).args, "evaluatorSpec holdout+caps+prior-blocking");
    // caps thread onto the negotiation roles too
    expectAccepted(withHoldoutCaps.contractGeneratorSpec(cround1).args, "contractGeneratorSpec caps");
    expectAccepted(withHoldoutCaps.contractEvaluatorSpec(cround1).args, "contractEvaluatorSpec caps");
    expectAccepted(withHoldoutCaps.generatorSpec(round1).args, "generatorSpec caps");
  });
});

describe("Pi loopCommand builders — Pi-runtime-free (assertion 5)", () => {
  let config: ReturnType<typeof buildRunUnitConfig>;
  beforeAll(() => {
    const parsed = parseLoopCommandArgs(
      `--brief ${briefPath} --contract ${contractPath} --holdout ${holdoutPath}`,
    );
    config = buildRunUnitConfig(parsed, { critiqueDir: tmp });
  });

  it("contract-evaluator spec (role run) accepted post-fix — carries --brief", () => {
    const args = config.contract.contractEvaluatorSpec(cround1).args;
    expect(args).toContain("--brief");
    expectAccepted(args, "Pi contractEvaluatorSpec");
    expectAccepted(config.contract.contractEvaluatorSpec(cround2).args, "Pi contractEvaluatorSpec re-critique");
  });

  it("generator spec (role run) accepted (round 1 + feedback round)", () => {
    expectAccepted(config.generatorSpec(round1).args, "Pi generatorSpec r1");
    expectAccepted(config.generatorSpec(round2).args, "Pi generatorSpec r2");
  });

  it("evaluator spec (`eval .` alias) accepted via seam alias normalization", () => {
    const args = config.evaluatorSpec(round1).args;
    expect(args[0]).toBe("eval");
    expectAccepted(args, "Pi evaluatorSpec eval-alias");
  });
});

describe("Pi roleRunner buildSpec — generic passthrough exercised (assertion 5)", () => {
  it("emits parser-acceptable argv for a representative `role run` input", async () => {
    let captured: RunRoleSpec | undefined;
    await runSparraRoleForTool(
      { args: ["role", "run", "--kind", "evaluator", "--contract", contractPath, "--json"] },
      {
        runRole: async (spec) => {
          captured = spec;
          return { roleKind: "evaluator", backend: "stub", model: "m", ok: true, errors: [], tokens: 0, costUsd: 0 };
        },
      },
    );
    expect(captured).toBeDefined();
    expectAccepted(captured!.args, "Pi buildSpec passthrough");
  });
});

describe("bridge conductor handler builders — every emitted argv accepted (assertion 7)", () => {
  it("buildRoleSpec argv (generator, briefPath) accepted", () => {
    const { spec } = buildRoleSpec(
      { workspace: tmp, kind: "generator", briefPath, contractPath },
      [tmp],
    );
    expectAccepted(spec.args, "bridge buildRoleSpec generator");
  });

  it("buildRoleSpec argv (evaluator, inline brief→--brief-text + holdout) accepted", () => {
    const { spec } = buildRoleSpec(
      { workspace: tmp, kind: "evaluator", brief: "do the thing", contractPath, holdoutPath },
      [tmp],
    );
    expect(spec.args).toContain("--brief-text");
    expectAccepted(spec.args, "bridge buildRoleSpec evaluator");
  });

  it("buildUnitConfig — all three specs accepted with a briefPath (contract-evaluator carries --brief)", () => {
    const { config } = buildUnitConfig(
      { workspace: tmp, briefPath, contractPath, holdoutPath },
      [tmp],
    );
    const ce = config.contract.contractEvaluatorSpec(cround1).args;
    expect(ce).toContain("--brief");
    expectAccepted(ce, "bridge contractEvaluatorSpec (briefPath)");
    expectAccepted(config.contract.contractEvaluatorSpec(cround2).args, "bridge contractEvaluatorSpec re-critique");
    expectAccepted(config.generatorSpec(round1).args, "bridge generatorSpec");
    expectAccepted(config.evaluatorSpec(round1).args, "bridge evaluatorSpec");
  });

  it("buildUnitConfig — contract-evaluator threads an INLINE brief as --brief-text (accepted)", () => {
    const { config } = buildUnitConfig(
      { workspace: tmp, brief: "do the thing", contractPath, holdoutPath },
      [tmp],
    );
    const ce = config.contract.contractEvaluatorSpec(cround1).args;
    expect(ce).toContain("--brief-text");
    expect(ce).not.toContain("--brief");
    expectAccepted(ce, "bridge contractEvaluatorSpec (inline brief)");
    expectAccepted(config.generatorSpec(round1).args, "bridge generatorSpec (inline brief)");
    expectAccepted(config.evaluatorSpec(round1).args, "bridge evaluatorSpec (inline brief)");
  });
});

describe("mutation-check — the historical missing-`--brief` bug is REJECTED (assertions 3, 8)", () => {
  it("a contract-evaluator argv WITHOUT --brief is rejected, naming the brief rule", () => {
    // The exact historical bad argv: `contractEvaluatorSpec` shipped without `--brief` and the first
    // real conduct run crashed at contract negotiation. The seam must catch it.
    const badArgv = [
      "role",
      "run",
      "--kind",
      "contract-evaluator",
      "--backend",
      "claude",
      "--model",
      "opus",
      "--contract",
      contractPath,
      "--json",
    ];
    const res = acceptArgv(badArgv, { root: tmp });
    expect(res.accepted).toBe(false);
    expect(res.reason).toMatch(/provide a brief/);

    // And the CORRECT argv (with --brief) IS accepted — proves this is a real discriminator, not an
    // always-reject harness.
    const goodArgv = [...badArgv];
    goodArgv.splice(goodArgv.indexOf("--contract"), 0, "--brief", briefPath);
    expect(acceptArgv(goodArgv, { root: tmp }).accepted).toBe(true);
  });
});
