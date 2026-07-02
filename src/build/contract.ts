import type { Ctx } from "../context.ts";
import { fill, loadPrompt } from "../prompts.ts";
import { runSession } from "../sdk/session.ts";
import type { RunResult, RunSessionParams } from "../sdk/session.ts";
import { readOnlyGuard } from "../sdk/guard.ts";
import { holdoutFreeCwd } from "./readscope.ts";
import { hasMarker } from "../util/extract.ts";
import { appendText, readText, writeText, exists } from "../util/io.ts";
import { detail, info, ok, warn } from "../util/log.ts";
import { readMemory, memorySection } from "../memory.ts";
import { readHoldout, assertNoHoldoutLeak, makeHoldoutReadDecider, redactHoldout } from "./holdout.ts";
import { classifyExec, extractVerifyCommands, renderExecOutcome, runVerifyCommand, type CommandExecutor } from "./exec.ts";
import { contractModeClauses } from "./modeText.ts";
import type { WorkItem } from "./types.ts";

const AGREED = "CONTRACT: AGREED";
const SECTION = "## AGREED CONTRACT";

export interface ContractResult {
  text: string;
  agreed: boolean;
  tracesUsed: number;
}

/**
 * Generator proposes a "done" contract; adversarial evaluator critiques; iterate
 * until the evaluator agrees or rounds run out. The full negotiation is persisted
 * to contracts/<id>.contract.md (so it's resumable and auditable). The final
 * agreed contract is the spec the generator/evaluator grade against.
 */
export async function negotiateContract(
  ctx: Ctx,
  item: WorkItem,
  traceDir: string,
  traceSeqStart: number,
  /** Prior learnings to inject (from .sparra/memory.md). Falls back to reading the file. */
  priorLearnings?: string,
  /** The worktree for an isolated build, else `ctx.root`; selects a holdout-free cwd. */
  workspaceDir?: string,
  /** Injectable for tests; defaults to the real SDK session (mirrors generateItem). */
  runSessionFn?: (p: RunSessionParams) => Promise<RunResult>,
  /** Injectable no-model executor for the verify-probe; defaults to the real safe executor. */
  executor?: CommandExecutor
): Promise<ContractResult> {
  const file = ctx.paths.contractFile(item.id);
  const run = runSessionFn ?? runSession;
  const exec = executor ?? runVerifyCommand;
  const cwd = holdoutFreeCwd(ctx, workspaceDir ?? ctx.root);

  // Resume: if a contract was already agreed, reuse it. A human may have edited it
  // (interactive contract steering), so leak-check the reused text here — fail clearly
  // now rather than later when the generator's own guard catches it.
  const prior = await readText(file);
  if (prior && prior.includes(SECTION)) {
    info(`Contract for ${item.id} already agreed — reusing.`);
    const reused = prior.split(SECTION)[1]!.trim();
    assertNoHoldoutLeak("contract (reused/edited)", reused, await readHoldout(ctx));
    return { text: reused, agreed: true, tracesUsed: 0 };
  }

  const genRole = ctx.config.roles.contractGenerator;
  const evalRole = ctx.config.roles.contractEvaluator;
  const vars = {
    MODE: ctx.store.data.mode,
    ASSERTION_MIN: String(ctx.config.contract.assertionMin),
    ASSERTION_MAX: String(ctx.config.contract.assertionMax),
    MODE_CLAUSES: contractModeClauses(ctx),
  };
  const genSystem = fill(await loadPrompt(ctx.paths, "contract-generator"), vars);
  const evalSystem = fill(await loadPrompt(ctx.paths, "contract-evaluator"), vars);

  const plan = (await readText(ctx.paths.frozenPlan)) ?? "";
  const map = await readText(ctx.paths.frozenMap);
  const memory = memorySection(priorLearnings ?? (await readMemory(ctx.paths)));
  const holdout = await readHoldout(ctx); // for the leak guard only — never injected here

  await writeText(
    file,
    `# Contract — ${item.id}: ${item.title}\n\n> Negotiated between generator and adversarial evaluator. The AGREED CONTRACT at the bottom is the spec.\n\n**Item summary:** ${item.summary}\n\n`
  );

  let proposal = "";
  let critique = "";
  let seq = traceSeqStart;
  let agreed = false;
  const maxRounds = ctx.config.contract.maxNegotiationRounds;

  for (let round = 1; round <= maxRounds; round++) {
    info(`Contract ${item.id}: round ${round}/${maxRounds}`);

    const genTask = `Work item ${item.id}: ${item.title}\n${item.summary}\n\nFROZEN PLAN (prior):\n---\n${plan.slice(0, 5000)}\n---\n${map ? `CODEBASE_MAP (conform to this):\n---\n${map.slice(0, 4000)}\n---\n` : ""}${memory}${round > 1 ? `\nThe evaluator critiqued your previous proposal. REVISE the contract to address every point.\n\nPREVIOUS PROPOSAL:\n${proposal}\n\nEVALUATOR CRITIQUE:\n${critique}\n` : ""}\nPropose the contract now.`;

    assertNoHoldoutLeak("contract-generator", genTask, holdout);
    const genRes = await run({
      role: "contract-generator",
      prompt: genTask,
      systemPrompt: genSystem,
      backend: genRole.backend,
      model: genRole.model,
      effort: genRole.effort,
      cwd,
      tools: ["Read", "Glob", "Grep"],
      // Forbid role: run in a holdout-free cwd (worktree when isolated; else ctx.root). Deny-decider
      // tracks THAT cwd as defense-in-depth on hooks-aware backends.
      ...readOnlyGuard(ctx, { extraDeny: [makeHoldoutReadDecider(ctx, cwd)] }),
      maxTurns: ctx.config.build.maxTurnsPerSession,
      traceDir,
      traceSeq: seq++,
    });
    proposal = genRes.resultText.trim();
    await appendText(file, `### Round ${round} — proposal\n\n${proposal}\n\n`);

    const evalTask = `Critique this proposed "done" contract for ${item.id}. Be adversarial.\n${memory}\nPROPOSED CONTRACT:\n${proposal}`;
    assertNoHoldoutLeak("contract-evaluator", evalTask, holdout);
    const evalRes = await run({
      role: "contract-evaluator",
      prompt: evalTask,
      systemPrompt: evalSystem,
      backend: evalRole.backend,
      model: evalRole.model,
      effort: evalRole.effort,
      cwd,
      tools: ["Read", "Glob", "Grep"],
      // Forbid role: run in a holdout-free cwd (worktree when isolated; else ctx.root). Deny-decider
      // tracks THAT cwd as defense-in-depth on hooks-aware backends.
      ...readOnlyGuard(ctx, { extraDeny: [makeHoldoutReadDecider(ctx, cwd)] }),
      maxTurns: ctx.config.build.maxTurnsPerSession,
      traceDir,
      traceSeq: seq++,
    });
    critique = evalRes.resultText.trim();
    await appendText(file, `### Round ${round} — critique\n\n${critique}\n\n`);

    if (hasMarker(critique, AGREED)) {
      // Harness verify-PROBE (no model): dry-run the agreed contract's verify commands. Two
      // outcomes re-open negotiation with the probe output: a USAGE error (broken as written:
      // not found / unknown flag / usage text) and an UNSAFE command (rejected by the safety
      // rules, never spawned — the harness can never run it, so it's broken-as-shipped too).
      // A BEHAVIORAL failure is expected pre-build and does not bounce.
      const brokenCommands: string[] = [];
      if (ctx.config.contract.probeVerifyCommands) {
        for (const cmd of extractVerifyCommands(proposal)) {
          // build.verifyCommands = the explicit opt-in past the executor's argv[0] allowlist.
          const o = await exec(workspaceDir ?? ctx.root, cmd, { allowPrefixes: ctx.config.build.verifyCommands });
          if (!o.ran || classifyExec(o) === "usage") brokenCommands.push(renderExecOutcome(o));
        }
      }
      if (brokenCommands.length === 0) {
        agreed = true;
        ok(`Contract ${item.id} agreed in round ${round}.`);
        break;
      }
      // Probe output flows into the next generator round's critique context — redact holdout
      // first (the existing redaction path), same wall as every other generator-visible text.
      const probeReport = redactHoldout(
        `HARNESS VERIFY-PROBE: the agreement is void — these "I will verify by" commands are broken AS WRITTEN (a usage error, or unsafe for the harness executor — single self-contained commands only: no chaining/redirect/network/mutation/commit; not a not-built-yet failure). Replace them with commands the harness can actually run, checked against the real surface (flags/subcommands/paths):\n${brokenCommands.map((e) => `- ${e}`).join("\n")}`,
        holdout
      );
      critique = `${critique}\n\n${probeReport}`;
      await appendText(file, `### Round ${round} — verify-probe (harness)\n\n${probeReport}\n\n`);
      warn(`Contract ${item.id}: verify-probe found ${brokenCommands.length} broken verify command(s) — re-opening negotiation.`);
      continue;
    }
    detail("evaluator not satisfied; generator will revise.");
  }

  if (!agreed) warn(`Contract ${item.id} not fully agreed after ${maxRounds} rounds — proceeding with the strongest proposal.`);
  await appendText(file, `${SECTION}\n\n${proposal}\n\n_${agreed ? "Agreed by evaluator." : "Forced after max rounds (not fully agreed)."}_\n`);

  return { text: proposal, agreed, tracesUsed: seq - traceSeqStart };
}
