import path from "node:path";
import type { Ctx } from "../context.ts";
import { readText } from "../util/io.ts";

/**
 * The isolation wall (from Kallistra): optional acceptance checks the human authors
 * in HOLDOUT.md that ONLY the evaluator sees. The generator and the contract
 * negotiation never see them, so the builder can't overfit/teach-to-the-test — a
 * second, independent gate on real behavior. Enforced in code via assertNoHoldoutLeak.
 */

/** Read the holdout (frozen copy preferred; falls back to the live file). "" if none. */
export async function readHoldout(ctx: Ctx): Promise<string> {
  return (await readText(ctx.paths.frozenHoldout)) ?? (await readText(ctx.paths.holdout)) ?? "";
}

/** Wrap holdout text for the EVALUATOR prompt. Pure; "" when there is no holdout. */
export function holdoutSection(text: string): string {
  if (!text.trim()) return "";
  return `\nHOLDOUT ACCEPTANCE CHECKS — the builder NEVER saw these; they guard against overfitting to the contract. Exercise each against the artifact and treat ANY holdout failure as BLOCKING (it fails the item regardless of rubric score):\n---\n${text.trim()}\n---\n`;
}

/** Redact any verbatim holdout line from conductor/human-facing text — used for
 *  role-run verdicts and interactive pause notes so the holdout the evaluator may
 *  quote never reaches the human/generator. */
export function redactHoldout(text: string, holdoutText: string): string {
  let out = text;
  for (const line of holdoutLines(holdoutText)) out = out.split(line).join("[redacted: holdout]");
  return out;
}

/** Substantive holdout lines (strip markdown markers; ignore short/structural lines). */
export function holdoutLines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.replace(/^[\s#>*\-\d.]+/, "").trim())
    .filter((l) => l.length >= 15);
}

/**
 * Code-enforced isolation wall: throw if any substantive holdout line appears in a
 * prompt the BUILDER (generator) or the contract negotiation can see. If holdout is
 * ever wired into those paths by mistake, the build fails loudly instead of silently
 * leaking the test.
 */
export function assertNoHoldoutLeak(role: string, prompt: string, holdoutText: string): void {
  if (!holdoutText.trim()) return;
  for (const line of holdoutLines(holdoutText)) {
    if (prompt.includes(line)) {
      throw new Error(
        `Holdout leaked into the ${role} prompt — the builder must never see holdout checks: "${line.slice(0, 60)}${line.length > 60 ? "…" : ""}"`
      );
    }
  }
}

/** A PreToolUse decider that denies a forbid role from reading the holdout file(s) — and the whole
 *  `.sparra` machinery dir (frozen holdout, verdicts, evaluator traces — all holdout-derived) — off
 *  disk, closing the gap the prompt-leak check alone can't (Read/Glob/Grep/Bash could `cat
 *  HOLDOUT.md`). Used by BOTH the interactive role-runner and the autonomous build-loop forbid
 *  roles (generator/reviewer/contract/decompose), so the wall is code-enforced everywhere.
 *  (Claude backend only; Codex ignores hooks — the prompt-wall + scope exclusion + verdict
 *  redaction are the guarantees there, and a cwd-resident holdout stays reachable on Codex.) */
export function makeHoldoutReadDecider(
  ctx: Ctx,
  workspace: string,
  explicitPath?: string
): (tool: string, input: unknown) => string | null {
  const sparraDir = path.resolve(ctx.paths.dir);
  const sparraBase = path.basename(sparraDir); // e.g. ".sparra"
  const protectedFiles = new Set(
    [ctx.paths.holdout, ctx.paths.frozenHoldout, explicitPath].filter(Boolean).map((p) => path.resolve(p as string))
  );
  const basenames = new Set([...protectedFiles].map((p) => path.basename(p)));
  const resolve = (p: string) => (path.isAbsolute(p) ? path.resolve(p) : path.resolve(workspace, p));
  const within = (child: string, parent: string) => {
    const rel = path.relative(parent, child);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  };
  const artifacts = [...protectedFiles, sparraDir];
  // A single-file READ is blocked when it IS / sits under a holdout artifact.
  const blockedReadTarget = (t: string) => {
    const abs = resolve(t);
    return protectedFiles.has(abs) || within(abs, sparraDir);
  };
  // A recursive SEARCH (Glob/Grep) reaches the holdout when its root is the holdout scope OR
  // CONTAINS it — so block when the search root is, sits under, or is an ANCESTOR of a holdout
  // artifact. A pathless Glob/Grep searches the cwd, so the cwd is the root then (this is the
  // pathless-search leak: contract/decomposer run with cwd = the holdout-bearing repo root).
  const blockedSearchRoot = (abs: string) =>
    protectedFiles.has(abs) || within(abs, sparraDir) || artifacts.some((a) => within(a, abs));
  // A search PATTERN that names the holdout/.sparra (e.g. `**/HOLDOUT.md`, `.sparra/**`) is blocked
  // regardless of where it's rooted.
  const patternRefsHoldout = (pat: string): boolean =>
    pat.includes(sparraBase) || pat.toLowerCase().includes("holdout") || [...basenames].some((b) => pat.includes(b));
  // BEST-EFFORT Bash matcher. A string blocklist can't be airtight against a shell on a backend
  // with no FS sandbox (string concatenation `cat ".sp""arra/…"`, an interpreter that assembles the
  // path, etc. evade any substring check) — the authoritative wall for Bash is that the holdout
  // lives OUTSIDE the role's cwd/read scope + the prompt wall + verdict redaction. We still raise
  // the bar well past literal `cat .sparra/HOLDOUT.md`: deny the dir name, the basenames, a
  // case-insensitive "holdout", AND any HIDDEN-path glob (`.s*`, `.[a-z]*`, `.*`) that could expand
  // into the dotted .sparra dir or a dotfile holdout.
  const hiddenGlob = /(?:^|[\s'"=:(<>|&/])\.[A-Za-z0-9_]*[*?[]/; // a dot-prefixed token containing a glob metachar
  const bashBlocked = (cmd: string): boolean => {
    if (cmd.includes(sparraDir) || cmd.includes(sparraBase)) return true;
    if (cmd.toLowerCase().includes("holdout")) return true;
    if ([...basenames].some((b) => cmd.includes(b))) return true;
    return hiddenGlob.test(cmd);
  };
  const DENY = "Holdout/.sparra is evaluator-only and not readable by this role.";
  return (tool, input) => {
    const i = input as { file_path?: string; path?: string; pattern?: string; command?: string } | undefined;
    if (tool === "Read") {
      const target = i?.file_path ?? i?.path;
      if (target && blockedReadTarget(target)) return DENY;
    }
    if (tool === "Glob" || tool === "Grep") {
      // Pathless search → the cwd is the search root (where the leak lives).
      const root = resolve(i?.path ?? i?.file_path ?? workspace);
      if (blockedSearchRoot(root)) return DENY;
      if (i?.pattern && patternRefsHoldout(i.pattern)) return DENY;
    }
    if (tool === "Bash" && bashBlocked(i?.command ?? "")) return DENY;
    return null;
  };
}
