import fs from "node:fs";
import path from "node:path";
import type { Ctx } from "../context.ts";

/** Mandatory contract clauses. Existing projects ALWAYS include no-regression + conventions. */
export function contractModeClauses(ctx: Ctx): string {
  if (ctx.store.data.mode === "existing") {
    return `MANDATORY CLAUSES (existing project — these MUST appear as assertions):
- "Does not regress existing behavior" — name the existing tests/flows that must still pass.
- "Conforms to the conventions in CODEBASE_MAP.md" — cite the specific patterns/idioms to follow.
- The existing test suite must pass with no NEW failures.`;
  }
  return `This is a greenfield project. Assertions should fully define "done" for this item;
there is no prior behavior to preserve.`;
}

/** Generator self-verification guidance — non-empty only when self-verify is actually available
 *  (verifyCommands configured AND on a worktree/branch boundary), so the generator isn't told to
 *  run checks it can't. Keeps it from "writing blind". */
export function selfVerifyGuidance(ctx: Ctx): string {
  const cmds = ctx.config.build.verifyCommands;
  if (!cmds.length || !ctx.store.data.build.branch) return "";
  return `SELF-VERIFY before you finish: you CAN run this project's checks via Bash. Use these commands AS WRITTEN: ${cmds
    .slice(0, 6)
    .join(", ")} — run them, READ the output, and FIX anything you broke. Do not report success on code you have not compiled/tested. ONLY these exact command forms are auto-approved: package-runner / path-qualified variants (\`npx tsc\`, \`./node_modules/.bin/vitest\`) and command chaining, redirects, network installs, or commits are NOT — they will be blocked, so don't substitute them. Writes stay inside your work tree.`;
}

/** The generator's deviation policy text, by mode + strictness. */
export function deviationPolicy(ctx: Ctx): string {
  const s = ctx.config.deviation.strictness;
  if (ctx.store.data.mode === "greenfield") {
    const base = `You are free to depart from the plan when it genuinely improves the product.`;
    const byStrict =
      s === "strict"
        ? `(strictness=strict) Even so, stay close to the contract; only deviate for clear correctness/quality wins.`
        : s === "moderate"
        ? `(strictness=moderate) Deviate when it clearly improves the result, staying within this item's scope.`
        : `(strictness=free) Optimize for the best product; deviate freely when justified.`;
    return `${base}\n${byStrict}\nRecord EVERY deviation in CHANGELOG.md with a rationale.`;
  }
  // existing
  const constrained = `Deviation is CONSTRAINED. You MAY improve within the scope of THIS work item, but you MUST NOT refactor or restructure unrelated/out-of-scope code, and you MUST NOT break existing behavior.`;
  const escalate = `Anything bigger (cross-cutting refactor, dependency change, API change beyond this item) is NOT done autonomously — log it as a proposal in .sparra/proposals/<short-name>.md for the human to decide.`;
  const byStrict =
    s === "strict"
      ? `(strictness=strict) Make the minimal change that satisfies the contract; no opportunistic edits.`
      : s === "moderate"
      ? `(strictness=moderate) In-scope improvements are welcome; out-of-scope ideas become proposals.`
      : `(strictness=free) You still may not touch out-of-scope code, but you have latitude within this item.`;
  return `${constrained}\n${escalate}\n${byStrict}\nRecord EVERY deviation in CHANGELOG.md with a rationale.`;
}

export function rubricText(ctx: Ctx): string {
  const w = ctx.config.rubric.weights;
  return [
    `- design (weight ${w.design})`,
    `- originality (weight ${w.originality})`,
    `- craft (weight ${w.craft})`,
    `- functionality (weight ${w.functionality})`,
    `Pass threshold: weighted total ≥ ${ctx.config.rubric.passThreshold}.`,
  ].join("\n");
}

/** List calibration reference files (good vs slop) so the evaluator anchors its taste. */
export function calibrationText(ctx: Ctx): string {
  if (!ctx.config.rubric.useCalibration) return "";
  const goodDir = path.join(ctx.paths.calibration, "good");
  const slopDir = path.join(ctx.paths.calibration, "slop");
  const ls = (d: string) => {
    try {
      return fs.readdirSync(d).filter((f) => !f.startsWith("."));
    } catch {
      return [];
    }
  };
  const good = ls(goodDir);
  const slop = ls(slopDir);
  if (good.length === 0 && slop.length === 0) return "";
  return `CALIBRATION — read these references to match the human's taste:
- "GOOD" examples (aim for this): ${good.map((f) => path.join(path.relative(ctx.root, goodDir), f)).join(", ") || "(none)"}
- "AI-SLOP" examples (avoid this): ${slop.map((f) => path.join(path.relative(ctx.root, slopDir), f)).join(", ") || "(none)"}
Read them with the Read tool before scoring originality/craft.`;
}

export function existingTestsText(ctx: Ctx): string {
  if (ctx.store.data.mode !== "existing" || !ctx.config.exercise.runExistingTests) return "";
  const cmd = ctx.config.exercise.existingTestCommand;
  return `EXISTING TEST SUITE: also run the repo's own tests${cmd ? ` (\`${cmd}\`)` : " (detect the command from CODEBASE_MAP.md)"} and treat ANY new failure as a HARD FAIL, regardless of the rubric score.`;
}
