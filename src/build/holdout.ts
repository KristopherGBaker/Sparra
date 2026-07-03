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
 *  redaction are the guarantees there, and a cwd-resident holdout stays reachable on Codex.)
 *
 *  Decisions are made on the paths a call will actually TOUCH, not on incidental substrings of the
 *  tool input — so a Grep whose content regex or a Glob whose filename merely mentions "holdout"
 *  (legitimate source like `src/build/holdout.ts` / `redactHoldout`) is NOT blocked, while real
 *  reads of a protected artifact still are:
 *    - Read: blocked when the target IS / sits under a holdout artifact.
 *    - Grep: the content `pattern` is never inspected (a regex can't read outside the search root);
 *      blocked only when the effective root reaches the holdout, or a path-shaped file filter
 *      (`glob`) names an artifact (judged as a Glob pattern).
 *    - Glob: the pattern IS path-shaped — blocked when any brace alternative resolves (with `..`
 *      and absolute prefixes applied) to/under an artifact, names a protected segment, or — being
 *      recursive (`**`) — descends into one. A pathless Glob of innocent explicit files is allowed
 *      even at a holdout-bearing cwd.
 *    - Bash: best-effort and path-based (see below). */
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
  // A recursive SEARCH ROOT (the Grep `path`, else the cwd) reaches the holdout when it IS the
  // holdout scope, sits UNDER it, or CONTAINS it (is an ancestor) — the search descends into it.
  // A pathless Grep searches the cwd, so the cwd is the root then (this is the pathless-search leak:
  // contract/decomposer run with cwd = the holdout-bearing repo root).
  const blockedSearchRoot = (abs: string) =>
    protectedFiles.has(abs) || within(abs, sparraDir) || artifacts.some((a) => within(a, abs));

  // Expand shell brace alternatives (`{a,b}` → ["a","b"]); handles nesting and multiple groups.
  const expandBraces = (pat: string): string[] => {
    const open = pat.indexOf("{");
    if (open === -1) return [pat];
    let depth = 0;
    let close = -1;
    for (let k = open; k < pat.length; k++) {
      if (pat[k] === "{") depth++;
      else if (pat[k] === "}" && --depth === 0) {
        close = k;
        break;
      }
    }
    if (close === -1) return [pat]; // unbalanced → treat literally
    const pre = pat.slice(0, open);
    const post = pat.slice(close + 1);
    const alts: string[] = [];
    let d = 0;
    let start = 0;
    const body = pat.slice(open + 1, close);
    for (let k = 0; k <= body.length; k++) {
      const c = body[k];
      if (c === "{") d++;
      else if (c === "}") d--;
      if (k === body.length || (c === "," && d === 0)) {
        alts.push(body.slice(start, k));
        start = k + 1;
      }
    }
    return alts.flatMap((a) => expandBraces(pre + a + post));
  };

  // Does one brace-expanded GLOB alternative resolve onto a protected artifact? Decide on the path
  // it targets, not its text: a literal `.sparra`/protected-basename segment names an artifact; the
  // literal prefix (up to the first wildcard) is resolved (applying `..`/absolute) to the dir the
  // glob scans from — deny when that dir IS/UNDER an artifact, or when a recursive `**` would
  // descend into an artifact contained beneath it.
  const altHitsArtifact = (alt: string, root: string): boolean => {
    const segs = alt.split("/").filter((s) => s !== "" && s !== ".");
    if (segs.some((s) => s === sparraBase || basenames.has(s))) return true;
    const literal: string[] = [];
    let sawWildcard = false;
    for (const s of segs) {
      if (/[*?[\]]/.test(s)) {
        sawWildcard = true;
        break;
      }
      literal.push(s);
    }
    const globstar = segs.some((s) => s.includes("**")); // a `**` anywhere means unbounded recursion
    const base = path.isAbsolute(alt)
      ? path.resolve("/" + literal.join("/"))
      : path.resolve(root, literal.join("/"));
    if (!sawWildcard) return protectedFiles.has(base) || within(base, sparraDir); // concrete target
    if (protectedFiles.has(base) || within(base, sparraDir)) return true; // scans from inside an artifact
    return globstar && artifacts.some((a) => within(a, base)); // `**` descends into a contained artifact
  };
  const globHitsArtifact = (pattern: string, root: string): boolean =>
    expandBraces(pattern).some((alt) => altHitsArtifact(alt, root));

  // BEST-EFFORT, PATH-BASED Bash matcher. A shell on a backend with no FS sandbox can always read an
  // absolute path or assemble one from pieces (`cat ".sp""arra/…"`, an interpreter, etc.), so no
  // string check is airtight — the authoritative wall is that the holdout lives OUTSIDE the role's
  // cwd/read scope + the prompt wall + verdict redaction. We deny commands that reference a protected
  // artifact BY PATH: the `.sparra` dir (name or absolute), a protected basename (`HOLDOUT.md` /
  // `HOLDOUT.frozen.md` / the explicit holdout), or a hidden-path glob (`.s*`, `.[a-z]*`, `.*`) that
  // could expand into the dotted `.sparra`. We deliberately do NOT block on a bare case-insensitive
  // "holdout" substring — that false-blocked legitimate source (`src/build/holdout.ts`,
  // `redactHoldout`); a command naming a real holdout ARTIFACT still trips the checks above.
  const hiddenGlob = /(?:^|[\s'"=:(<>|&/])\.[A-Za-z0-9_]*[*?[]/; // a dot-prefixed token containing a glob metachar
  const bashBlocked = (cmd: string): boolean => {
    if (cmd.includes(sparraDir) || cmd.includes(sparraBase)) return true;
    if ([...basenames].some((b) => cmd.includes(b))) return true;
    return hiddenGlob.test(cmd);
  };
  const DENY = "Holdout/.sparra is evaluator-only and not readable by this role.";
  const DENY_ROOT =
    "Search is rooted at a holdout-bearing dir (it contains .sparra) — pass an explicit non-holdout subdir path like src/ instead.";
  return (tool, input) => {
    const i = input as
      | { file_path?: string; path?: string; pattern?: string; glob?: string; command?: string }
      | undefined;
    if (tool === "Read") {
      const target = i?.file_path ?? i?.path;
      if (target && blockedReadTarget(target)) return DENY;
    }
    if (tool === "Grep") {
      // Content `pattern` is never inspected; deny only on the search root or a path-shaped filter.
      const root = resolve(i?.path ?? workspace);
      if (blockedSearchRoot(root)) return DENY_ROOT;
      if (i?.glob && globHitsArtifact(i.glob, root)) return DENY;
    }
    if (tool === "Glob") {
      // The pattern IS path-shaped — decide on the targets it resolves to, not the root shape.
      const root = resolve(i?.path ?? workspace);
      if (i?.pattern) {
        if (globHitsArtifact(i.pattern, root)) return DENY;
      } else if (blockedSearchRoot(root)) return DENY_ROOT; // pattern-less Glob → fall back to the root rule
    }
    if (tool === "Bash" && bashBlocked(i?.command ?? "")) return DENY;
    return null;
  };
}
