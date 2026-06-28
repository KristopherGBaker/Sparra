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
import { readHoldout, assertNoHoldoutLeak, makeHoldoutReadDecider } from "./holdout.ts";
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
  runSessionFn?: (p: RunSessionParams) => Promise<RunResult>
): Promise<ContractResult> {
  const file = ctx.paths.contractFile(item.id);
  const run = runSessionFn ?? runSession;
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
      agreed = true;
      ok(`Contract ${item.id} agreed in round ${round}.`);
      break;
    }
    detail("evaluator not satisfied; generator will revise.");
  }

  if (!agreed) warn(`Contract ${item.id} not fully agreed after ${maxRounds} rounds — proceeding with the strongest proposal.`);
  await appendText(file, `${SECTION}\n\n${proposal}\n\n_${agreed ? "Agreed by evaluator." : "Forced after max rounds (not fully agreed)."}_\n`);

  return { text: proposal, agreed, tracesUsed: seq - traceSeqStart };
}
