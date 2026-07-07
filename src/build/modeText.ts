import fs from "node:fs";
import path from "node:path";
import type { Ctx } from "../context.ts";

/** The role kinds that write to the workspace — ONLY these can self-verify, so only they
 *  receive the verify-gate advisory.  "generator" is the sole writer; all judge/read-only
 *  roles are excluded.  Using a Set so new writer kinds can be added in one place. */
const WRITER_ROLE_KINDS: ReadonlySet<string> = new Set(["generator"]);

/** Mandatory contract clauses. Existing projects ALWAYS include no-regression + conventions. */
export function contractModeClauses(ctx: Ctx): string {
  if (ctx.store.data.mode === "existing") {
    // The conventions clause must stay SATISFIABLE: a config-less ad-hoc loop never ran `orient`, so
    // CODEBASE_MAP.md is absent and demanding conformance to it is unmeetable. Degrade to the repo's
    // actual convention source when no map exists.
    const hasMap = fs.existsSync(ctx.paths.codebaseMap) || fs.existsSync(ctx.paths.frozenMap);
    const conventions = hasMap
      ? `- "Conforms to the conventions in CODEBASE_MAP.md" — cite the specific patterns/idioms to follow.`
      : `- "Conforms to the repo's existing conventions" — cite the actual source (CLAUDE.md / the surrounding code); there is no CODEBASE_MAP.md (orient was not run), so do NOT require conformance to that file.`;
    return `MANDATORY CLAUSES (existing project — these MUST appear as assertions):
- "Does not regress existing behavior" — name the existing tests/flows that must still pass.
${conventions}
- The existing test suite must pass with no NEW failures.`;
  }
  return `This is a greenfield project. Assertions should fully define "done" for this item;
there is no prior behavior to preserve.`;
}

/** Generator self-verification guidance — non-empty only when self-verify is actually available
 *  (verifyCommands configured AND either on a worktree/branch boundary OR an explicit in-place
 *  `allowVerify` opt-in), so the generator isn't told to run checks it can't. Keeps it from
 *  "writing blind". `allowVerify` mirrors the guard's `verifyInPlace` opt: an in-place `run_role`
 *  (no `build.branch`) that opted into the allow-hook must ALSO be told which commands it may run,
 *  else the hook permits the Bash but the model never attempts it (friction not actually removed).
 *  `onWorktreeBoundary` mirrors the guard's `onWorktreeBoundary` opt: when the runner detects that
 *  the workspace is a linked git worktree (e.g. a `unitWorktree` persistent generator tree) the
 *  guidance is enabled deterministically — the SAME enabling condition as the guard, so the guard
 *  and the warning cannot diverge. Pass the runner's `onLinkedWorktree` signal here (Assertion 2). */
export function selfVerifyGuidance(ctx: Ctx, allowVerify = false, onWorktreeBoundary = false): string {
  const cmds = ctx.config.build.verifyCommands;
  if (!cmds.length || !(ctx.store.data.build.branch || allowVerify || onWorktreeBoundary)) return "";
  return `SELF-VERIFY before you finish: you CAN run this project's checks via Bash. Use these commands AS WRITTEN: ${cmds
    .slice(0, 6)
    .join(", ")} — run them, READ the output, and FIX anything you broke. Tool output is TRUNCATED, so run each AS WRITTEN and read the tail/summary. Auto-approved Bash shapes: (a) exact listed command (a \`<cmd> -- <args>\` suffix is fine — it still starts with the allowed command); (b) a leading LITERAL env-var assignment, e.g. \`TMPDIR=/tmp/x ${cmds[0] ?? "npm test"}\` or \`LANG=C ${cmds[0] ?? "npm test"}\` — KEY must be a plain identifier, VALUE must be metacharacter-free; (c) piping the command into a read-only text filter, e.g. \`${cmds[0] ?? "npm test"} 2>&1 | tail -20\`, \`| head\`, \`| grep\`, \`| wc -l\` — filter args are validated (no file read/write). Still blocked: \`&&\`/\`;\` chaining, real-file redirects (\`> file\`), \`cd X &&\`/\`git -C <abs>\` wrapping, subshell/command-substitution, installs, commits. Do not substitute a \`npx\`/\`./node_modules/.bin\` variant — those are NOT approved, stall on the guard, and only burn turns. Writes stay inside your work tree.`;
}

/**
 * Launch-time advisory surfaced when ALL of these hold:
 *  1. `roleKind` is a WRITER role (currently only "generator") — never a read-only judge.
 *  2. Self-verify is NOT enabled for this run: neither a `build.branch`/worktree boundary
 *     nor an explicit `allowVerify` opt-in (the same pair `selfVerifyGuidance` checks).
 *  3. The contract text references at least one command from `ctx.config.build.verifyCommands`.
 *
 * When all three hold the generator will hit an approval wall on every gate command — a
 * structurally-guaranteed "unverified" claim — the evaluator will observe it as unverified
 * assertions and the conductor will only learn about it post-session.  This advisory names
 * the specific blocked commands and how to enable them so the conductor can act BEFORE the
 * session launches, instead of finding out after the fact.
 *
 * Returns null when self-verify IS enabled, when no configured verify command appears in the
 * contract, when `verifyCommands` is empty, or when `roleKind` is not a writer.
 *
 * Assertion 4 (reuses existing logic): callers MUST compute `selfVerifyEnabled` via
 * `selfVerifyGuidance(ctx, allowVerify) !== ""` — the predicate defined once above — so there
 * is no divergent copy of the availability check.  The parameter is a boolean so the helper
 * itself stays pure and testable without a ctx branch.
 *
 * HOLDOUT-SAFE: the returned string contains only command strings from the config and
 * guidance text — never any portion of `contractText` or holdout body.
 */
export function verifyGateWarning(
  roleKind: string,
  contractText: string,
  ctx: Ctx,
  selfVerifyEnabled: boolean
): string | null {
  if (!WRITER_ROLE_KINDS.has(roleKind)) return null;
  if (selfVerifyEnabled) return null;
  const cmds = ctx.config.build.verifyCommands;
  if (!cmds.length) return null;
  const gated = cmds.filter((cmd) => contractText.includes(cmd));
  if (!gated.length) return null;
  return (
    `[VERIFY-GATE ADVISORY] This generator role-run's contract references the following ` +
    `configured verify command(s): ${gated.map((c) => `\`${c}\``).join(", ")}. ` +
    `Self-verify is NOT enabled for this run (no build.branch / worktree boundary, and ` +
    `allowVerify was not passed), so these commands are approval-blocked — the generator ` +
    `can only claim them "unverified". ` +
    `To enable: pass \`allowVerify: true\` (MCP run_role) / \`--verify\` (sparra role run CLI) ` +
    `so the strict allow-hook approves them in-place, or run on a git worktree/branch boundary ` +
    `(\`build.branch\` / \`unitWorktree\`).`
  );
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

/** Anchored rubric: one-line criterion definitions + a generic band scale, so scores are
 *  grounded rather than free-floating model judgment. Rendered into every evaluator prompt —
 *  keep it terse. */
export function rubricText(ctx: Ctx): string {
  const w = ctx.config.rubric.weights;
  return [
    `- design (weight ${w.design}): architecture/API/UX fit the problem — right-sized, coherent, no needless complexity.`,
    `- originality (weight ${w.originality}): real judgment, not boilerplate/AI-slop — approach fits THIS problem.`,
    `- craft (weight ${w.craft}): code quality — naming, structure, error handling, tests, conventions.`,
    `- functionality (weight ${w.functionality}): works when exercised — contract assertions hold with evidence.`,
    `Bands (each criterion): 90+ exemplary, no substantive flaw; 70-89 solid, minor issues; 50-69 notable gaps; <50 broken/deficient.`,
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
