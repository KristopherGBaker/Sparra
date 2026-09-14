import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Ctx } from "../context.ts";
import type { RetiredHoldout } from "./types.ts";
import { readText } from "../util/io.ts";
import { warn } from "../util/log.ts";

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
  return `\nHOLDOUT ACCEPTANCE CHECKS — the builder NEVER saw these; they guard against overfitting to the contract. Exercise each against the artifact and treat ANY holdout failure as BLOCKING (it fails the item regardless of rubric score) — with ONE exception: a holdout that DIRECTLY, logically contradicts the agreed contract (it demands behavior the contract explicitly forbids, or forbids behavior it explicitly mandates) is NOT a valid check — flag it CONTRACT-CONTRADICTED in \`holdoutContradictions\` (quoting the contradicted contract clause verbatim) instead of failing the artifact; the harness retires it. "Inconvenient" never qualifies:\n---\n${text.trim()}\n---\n`;
}

/** Normalize a holdout assertion's text for a STABLE, holdout-safe id / match: lowercase, strip
 *  markdown markers, collapse whitespace. Reveals no holdout text (only feeds the hash / a match). */
export function normalizeHoldout(text: string): string {
  return text
    .toLowerCase()
    .replace(/[#>*`_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Short, stable, holdout-SAFE id for a holdout assertion — a content hash of its normalized text.
 *  Reveals no holdout text, is stable across rounds, and distinguishes multiple holdouts after
 *  redaction (the durable retirement record is keyed by this). */
export function holdoutId(text: string): string {
  return createHash("sha256").update(normalizeHoldout(text)).digest("hex").slice(0, 12);
}

/** The marker line naming the durable retirement section in a persisted verdict file. Grep-precise
 *  (carries the literal `CONTRACT-CONTRADICTED`) so the stale-claim sweep and re-grade threading can
 *  both detect it. */
export const RETIRED_HOLDOUT_MARKER = "Retired holdouts (CONTRACT-CONTRADICTED)";

/** Render the durable, holdout-SAFE retirement section for a verdict file. Keyed by `holdoutId`
 *  (no holdout text); names the cited contract clause + reason. "" when there is nothing retired.
 *  The clause/reason are already holdout-redacted by the caller; inner quotes are stripped so the
 *  section stays machine-parseable by `parseRetiredHoldouts`. */
export function renderRetiredHoldouts(records: RetiredHoldout[]): string {
  if (!records.length) return "";
  const safe = (s: string) => s.replace(/"/g, "'").replace(/\s+/g, " ").trim();
  const lines = records.map(
    (r) => `- holdoutId \`${r.holdoutId}\` — contract clause: "${safe(r.contractClause)}"${r.reason ? ` — reason: ${safe(r.reason)}` : ""}`
  );
  return `## ${RETIRED_HOLDOUT_MARKER}\n${lines.join("\n")}\n`;
}

/** Parse durable retirement records back out of a persisted verdict file's retirement section —
 *  the inverse of `renderRetiredHoldouts`, used by later-round re-grade threading. */
export function parseRetiredHoldouts(text: string): RetiredHoldout[] {
  const out: RetiredHoldout[] = [];
  const re = /- holdoutId `([0-9a-f]+)` — contract clause: "([^"]*)"(?: — reason: ([^\n]*))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push({ holdoutId: m[1]!, contractClause: m[2]!, reason: (m[3] ?? "").trim() });
  return out;
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
 *      and absolute prefixes applied) to/under an artifact, names a protected segment (literal OR a
 *      wildcard matching a protected basename — `HOLDOUT.*`/`HOLD*`/`*OUT.md`), or EXACTLY matches a
 *      concrete protected file (`artifacts` = the holdout/frozen-holdout/explicit path + `.sparra`
 *      itself). Fix round 3 pivot (a hand-maintained list of *example* artifact filenames — one round-2
 *      tried — is inherently incomplete: a shape absent from the list silently flips DENY→ALLOW, as
 *      happened for a trace file, a `proposals/` file, and a `reflect/` file). Instead, ANY wildcard
 *      tail that structurally DESCENDS into `.sparra` — a (possibly recursive `**`) prefix fully
 *      consumes the path down to the `.sparra` boundary with at least one pattern segment left to
 *      enumerate beneath it (`matchGlobPrefix`) — is denied BY DEFAULT, regardless of what that final
 *      segment names; this needs no knowledge of any specific artifact shape, so no new trace/
 *      proposal/reflect/verdict/config filename can slip through un-anticipated. The ONE narrow,
 *      explicitly-justified exception (`SAFE_RECURSIVE_TAILS`) is a basename shape PROVEN to never
 *      correspond to a Sparra artifact — `vitest.config.*` — the required positive fixture for a
 *      root-anchored recursive Glob that cannot reach a protected artifact; it does not broaden to
 *      any pattern that also names a real path segment ahead of the tail. Patterned Glob and Grep
 *      `glob` filters share this same resolved-match-language decision; pattern-less searches still
 *      use the stricter root rule because they can enumerate every artifact below the root regardless
 *      of filename.
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

  // Minimatch-style single-segment glob → anchored regex (matches ONE path segment; `*`/`?` never
  // cross `/`). This is the defense against WILDCARD-basename evasion: exact-string equality alone
  // let any wildcard in the final segment slip the wall (`HOLDOUT.*`, `HOLD*`, `*OUT.md` all evaded).
  // `dot:false` semantics — a leading `*`/`?`/`[` will NOT match a name starting with `.` (so a bare
  // `*` can't stand in for `.sparra`), but an explicit-dot pattern (`.s*`, `.[a-z]*`) still can.
  const GLOB_META = /[*?[\]]/;
  const segToRegex = (seg: string): RegExp => {
    let re = "";
    for (let k = 0; k < seg.length; k++) {
      const c = seg[k]!;
      if (c === "*") re += "[^/]*";
      else if (c === "?") re += "[^/]";
      else if (c === "[") {
        let end = k + 1;
        if (seg[end] === "!" || seg[end] === "^") end++;
        if (seg[end] === "]") end++; // a literal `]` as the first class member
        while (end < seg.length && seg[end] !== "]") end++;
        if (end >= seg.length) re += "\\["; // unclosed class → literal `[`
        else {
          re += "[" + seg.slice(k + 1, end).replace(/^!/, "^") + "]";
          k = end;
        }
      } else re += c.replace(/[.+^${}()|\\]/g, "\\$&");
    }
    const head = /[*?[]/.test(seg[0] ?? "") ? "(?!\\.)" : ""; // leading wildcard doesn't match a dotfile
    return new RegExp("^" + head + re + "$");
  };
  const artifactNames = new Set([sparraBase, ...basenames]);
  // Does a path segment NAME a protected artifact — the `.sparra` dir or a protected basename?
  // Exact match, OR a WILDCARD segment whose glob matches one of those names. `**` (recursion, not a
  // basename) is excluded here. Directory-AGNOSTIC — used only by the best-effort Bash matcher, where
  // a bare token like `HOLDOUT.*` is suspicious wherever it sits (the Glob path is dir-aware instead).
  const segNamesArtifact = (seg: string): boolean =>
    artifactNames.has(seg) ||
    (GLOB_META.test(seg) && !seg.includes("**") && [...artifactNames].some((n) => segToRegex(seg).test(n)));

  // Recursive minimatch of a relative glob (segments) against a relative path (segments); `**`
  // matches zero or more path segments. Lets the Glob path ask, directory-AWARE, whether a wildcard
  // pattern actually resolves ONTO a specific protected artifact under the dir it scans.
  const matchGlobPath = (pat: string[], parts: string[], protectedPath = false): boolean => {
    if (pat.length === 0) return parts.length === 0;
    const [head, ...rest] = pat;
    if (head === "**") {
      for (let i = 0; i <= parts.length; i++) if (matchGlobPath(rest, parts.slice(i), protectedPath)) return true;
      return false;
    }
    if (parts.length === 0) return false;
    // Treat wildcard directory segments conservatively for protected paths: Glob implementations
    // vary in dot-directory traversal, and the holdout wall must not depend on that ambient option.
    const matches = segToRegex(head!).test(parts[0]!) ||
      (protectedPath && parts[0]!.startsWith(".") && GLOB_META.test(head!) && segToRegex("." + head!).test(parts[0]!));
    return matches && matchGlobPath(rest, parts.slice(1), protectedPath);
  };

  // Does the glob (segments) DESCEND INTO `parts` — i.e. some prefix of the pattern fully consumes
  // `parts` (the path down to a protected dir, ALWAYS `.sparra` here) with at least one pattern
  // segment left to enumerate BELOW it? This is the DEFAULT-DENY safety net (fix round 3): unlike
  // `matchGlobPath`'s exact-artifact match, it needs no knowledge of any specific artifact's shape —
  // a wildcard tail that merely REACHES `.sparra` with something left to list is presumed dangerous,
  // so an unanticipated future filename (a trace, a proposal, a reflect summary, …) can't slip through
  // un-named. Same dot-directory conservatism as `matchGlobPath` (a bare `*` still reaches a dotdir).
  const matchGlobPrefix = (pat: string[], parts: string[]): boolean => {
    if (parts.length === 0) return pat.length > 0; // reached the dir; remaining pattern lists inside it
    if (pat.length === 0) return false;
    const [head, ...rest] = pat;
    if (head === "**") {
      for (let i = 0; i <= parts.length; i++) if (matchGlobPrefix(rest, parts.slice(i))) return true;
      return false;
    }
    const matches = segToRegex(head!).test(parts[0]!) ||
      (parts[0]!.startsWith(".") && GLOB_META.test(head!) && segToRegex("." + head!).test(parts[0]!));
    return matches && matchGlobPrefix(rest, parts.slice(1));
  };

  // The ONE required positive fixture (#1): a root-anchored RECURSIVE Glob whose final segment is
  // PROVEN to never correspond to a real Sparra artifact. Every artifact `Paths` (src/paths.ts) can
  // ever produce ends in `.md`/`.json`/`.yaml` and is drawn from a small closed name set (config.yaml,
  // state.json, memory.md, environment.md, `*.contract.md`, `*.rN.verdict.md`, `*.rN.review.md`,
  // `<NN>-<role>.md` traces, `<item>-<n>.md` proposals, reflect's SUMMARY.md/upstream.md/INDEX.md,
  // `.baseline.json`, …) — none of which is `vitest.config.<ext>`, a dev-tooling file that legitimately
  // lives at the repo root. Scoped NARROWLY: only exempts a pattern whose sole path-shape ahead of the
  // final segment is unbounded recursion (`**`) — a literal segment naming a real subdirectory
  // (`traces`, `proposals`, `reflect`, …) ahead of the tail still denies via `matchGlobPrefix` above.
  const SAFE_RECURSIVE_TAILS = new Set(["vitest.config.*"]);
  const hasProvablySafeTail = (segs: string[]): boolean => {
    const tail = segs[segs.length - 1];
    return tail !== undefined && segs.slice(0, -1).every((s) => s === "**") && SAFE_RECURSIVE_TAILS.has(tail);
  };

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
  // it targets, not its text: a LITERAL `.sparra`/protected-basename segment names an artifact; else
  // the literal prefix (up to the first wildcard) is resolved (applying `..`/absolute) to the dir the
  // glob scans from — deny when that dir IS/UNDER an artifact, when the WILDCARD tail actually matches
  // a protected artifact sitting under that dir (closing `HOLDOUT.*`/`HOLD*`/`*OUT.md` basename
  // evasion, directory-aware), or when a recursive `**` would descend into an artifact beneath it.
  const altHitsArtifact = (alt: string, root: string): boolean => {
    const segs = alt.split("/").filter((s) => s !== "" && s !== ".");
    if (segs.some((s) => artifactNames.has(s))) return true; // a literal `.sparra`/basename segment
    const literal: string[] = [];
    let sawWildcard = false;
    for (const s of segs) {
      if (GLOB_META.test(s)) {
        sawWildcard = true;
        break;
      }
      literal.push(s);
    }
    const base = path.isAbsolute(alt)
      ? path.resolve("/" + literal.join("/"))
      : path.resolve(root, literal.join("/"));
    if (!sawWildcard) return protectedFiles.has(base) || within(base, sparraDir); // concrete target
    if (protectedFiles.has(base) || within(base, sparraDir)) return true; // scans from inside an artifact
    // WILDCARD-basename evasion: does the glob (resolved under `base`) actually MATCH a protected
    // CONCRETE artifact sitting in the dir it scans? (`HOLDOUT.*`/`HOLD*`/`*OUT.md` at a root holding
    // the live <root>/HOLDOUT.md, or the explicit holdout path.) Directory-aware, so an innocent
    // `docs/*.md` never reaches a root-level holdout.
    const restSegs = segs.slice(literal.length);
    for (const a of artifacts) {
      const rel = path.relative(base, a);
      if (rel && !rel.startsWith("..") && !path.isAbsolute(rel) && matchGlobPath(restSegs, rel.split(path.sep), true))
        return true;
    }
    // STRUCTURAL descent (fix round 3, see `matchGlobPrefix` above): the wildcard tail traverses INTO
    // `.sparra` — enumerating SOME filename beneath it — even without matching any concrete artifact
    // by name. Denied by default; the one narrow, justified exception is `hasProvablySafeTail`.
    const relDir = path.relative(base, sparraDir);
    if (
      relDir &&
      !relDir.startsWith("..") &&
      !path.isAbsolute(relDir) &&
      !hasProvablySafeTail(restSegs) &&
      matchGlobPrefix(restSegs, relDir.split(path.sep))
    )
      return true;
    return false;
  };
  const globHitsArtifact = (pattern: string, root: string): boolean =>
    expandBraces(pattern).some((alt) => altHitsArtifact(alt, root));

  // ── Bash: decide on RESOLVED PATH OPERANDS, never on raw command text ───────────────────────────
  //
  // BEST-EFFORT by construction. A shell on a backend with no FS sandbox can always read an absolute
  // path or assemble one from pieces (`cat ".sp""arra/…"`, an interpreter, base64), so no string check
  // is airtight — the authoritative wall is that the holdout lives OUTSIDE the role's cwd/read scope,
  // plus the prompt wall and verdict redaction.
  //
  // What it must NOT do is refuse commands that touch nothing it protects. Matching raw TEXT did
  // exactly that: `rg -n "x" docs/*.md` was denied because the TOKEN `*.md` could match the basename
  // `HOLDOUT.md` *somewhere* (the old check was directory-agnostic), and `rg -n '^#+ .*§'` was denied
  // because a REGEX argument looked like a dotfile glob. Both refusals claimed "evaluator-only
  // artifacts", sending the role hunting for a path problem it did not have.
  //
  // So: tokenize the command, keep only the tokens that are actually PATH OPERANDS (no command words,
  // no flags, no regex patterns), and resolve each against the real artifact locations — directory-
  // aware, via the SAME `globHitsArtifact` the Glob tool path uses. `docs/*.md` then resolves under
  // `docs/` and reaches nothing, while `cat HOLDOUT.*`, `cat .*`, `ls .sparra/…` and
  // `find . -name '*.md'` (which really would enumerate a root-level holdout) still deny.

  /** Runtime expansion — the operand list cannot be resolved statically ahead of the shell. */
  const DYNAMIC = /\$\(|\$\{|\$[A-Za-z_]|`|\beval\b|\bxargs\b|\b(?:ba)?sh\s+-c\b/;
  /** Commands whose FIRST operand is a regex/pattern rather than a path. */
  const PATTERN_FIRST = new Set(["rg", "grep", "egrep", "fgrep", "ag", "ack", "sed", "awk", "perl"]);
  /** Flags whose VALUE is a regex/pattern — skipped entirely (it names nothing on disk). */
  const PATTERN_FLAGS = new Set(["-e", "--regexp", "--regex", "--expression"]);
  /** Flags whose VALUE is a path-shaped FILTER (`--glob '!*.json'`, `-name '*.md'`). Evaluated like
   *  any operand — a filter CAN reach an artifact — but it must not consume the positional pattern
   *  slot below, or the real regex would be read as a path. Deliberately conservative: we do not
   *  model how a tool's own root argument narrows its filter, so `--include='*.md'` is judged from
   *  the workspace (where it really would enumerate a root-level holdout). */
  const GLOB_FLAGS = new Set([
    "--glob", "-g", "--iglob", "--include", "--exclude", "--exclude-dir", "-f", "--file",
    "-name", "-iname", "-path", "-ipath", "-wholename",
  ]);
  /** Flags whose VALUE is neither a path nor a pattern (counts, types, context windows). */
  const VALUE_FLAGS = new Set([
    "-t", "--type", "-m", "--max-count", "-A", "-B", "-C", "--after-context", "--before-context",
    "--context", "--max-depth", "--maxdepth", "-maxdepth", "-S", "--sort",
  ]);
  /** Wrappers that prefix the real command word. */
  const WRAPPERS = new Set(["sudo", "env", "time", "nice", "nohup", "command", "builtin", "exec"]);

  /**
   * Split a command into pipeline/list SEGMENTS of tokens, honoring quotes and escapes. `confident`
   * is false when the command carries runtime expansion or an unbalanced quote — the operand list is
   * then a guess, not a parse, and callers must not treat it as a policy verdict.
   */
  const shellSegments = (cmd: string): { segments: string[][]; confident: boolean } => {
    const segments: string[][] = [];
    let seg: string[] = [];
    let tok = "";
    let held = false; // a quoted empty string is still a token
    let quote: '"' | "'" | null = null;
    const pushTok = () => {
      if (tok !== "" || held) seg.push(tok);
      tok = "";
      held = false;
    };
    const pushSeg = () => {
      pushTok();
      if (seg.length) segments.push(seg);
      seg = [];
    };
    for (let k = 0; k < cmd.length; k++) {
      const c = cmd[k]!;
      if (quote) {
        if (c === quote) quote = null;
        else tok += c;
        continue;
      }
      if (c === '"' || c === "'") {
        quote = c;
        held = true;
        continue;
      }
      if (c === "\\") {
        const n = cmd[++k];
        if (n !== undefined) tok += n;
        continue;
      }
      if (/\s/.test(c)) pushTok();
      else if (c === "|" || c === ";" || c === "&" || c === "(" || c === ")") pushSeg();
      else if (c === ">" || c === "<") pushTok(); // the redirect TARGET becomes its own token (a path)
      else tok += c;
    }
    pushSeg();
    return { segments, confident: quote === null && !DYNAMIC.test(cmd) };
  };

  /** The tokens of a parsed command that are actually PATH operands. */
  const pathOperands = (segments: string[][]): string[] => {
    const out: string[] = [];
    for (const seg of segments) {
      let k = 0;
      // Leading `VAR=value` assignments: not operands, but the VALUE can name a path.
      while (k < seg.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(seg[k]!)) out.push(seg[k++]!.split("=").slice(1).join("="));
      while (k < seg.length && WRAPPERS.has(path.basename(seg[k]!))) k++;
      const cmdWord = k < seg.length ? path.basename(seg[k]!) : "";
      k++; // the command word itself is never an operand
      let firstOperand = true;
      for (; k < seg.length; k++) {
        const t = seg[k]!;
        if (t.startsWith("-") && t.length > 1) {
          if (PATTERN_FLAGS.has(t) || VALUE_FLAGS.has(t)) k++; // the value names nothing on disk
          else if (GLOB_FLAGS.has(t)) {
            const v = seg[++k];
            if (v !== undefined) out.push(v); // a path-shaped filter: judged, but not the pattern slot
          } else {
            const eq = t.indexOf("=");
            if (eq > 0 && GLOB_FLAGS.has(t.slice(0, eq))) out.push(t.slice(eq + 1)); // --include=*.md
          }
          continue; // the flag itself names nothing
        }
        if (firstOperand && PATTERN_FIRST.has(cmdWord)) {
          firstOperand = false; // rg/grep/sed/awk take the PATTERN here
          continue;
        }
        firstOperand = false;
        out.push(t);
      }
    }
    return out;
  };

  // Guidance that names paths from the project ACTUALLY in play, resolved once on first denial —
  // the old text suggested `src/` and `**/vitest.config.*`, JS boilerplate in, say, a Swift repo.
  let safeExamples: string | undefined;
  const suggestion = (): string => {
    if (safeExamples === undefined) {
      let names: string[] = [];
      try {
        names = fs
          .readdirSync(workspace, { withFileTypes: true })
          .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !["node_modules", "build", "dist"].includes(e.name))
          .slice(0, 3)
          .map((e) => `${e.name}/`);
      } catch {
        names = [];
      }
      safeExamples = names.length ? ` — e.g. ${names.join(", ")}` : "";
    }
    return safeExamples;
  };
  const artifactLabel = [sparraBase + "/", ...basenames].join(", ");
  /** Deny naming the OFFENDING target and the real reason. */
  const denyTarget = (what: string, target: string): string =>
    `${what} \`${target}\` resolves onto evaluator-only artifacts (${artifactLabel}) — retarget it outside them${suggestion()}.`;

  const bashDenial = (cmd: string): string | null => {
    // Literal reference to a protected path/name, case-insensitively (a case-insensitive FS makes
    // `cat holdout.md` / `.SPARRA/…` read the real artifact). Checked on the raw text ON PURPOSE:
    // it is the assembled-path defense, and it still applies when the parse below is not confident.
    const lc = cmd.toLowerCase();
    const literal = [sparraDir, sparraBase, ...basenames].find((n) => lc.includes(n.toLowerCase()));
    if (literal !== undefined) return denyTarget("Command names protected artifact", literal);
    const { segments, confident } = shellSegments(cmd);
    if (!confident) {
      // The operands cannot be resolved ahead of the shell (expansion, eval, an unbalanced quote).
      // ALLOW and AUDIT rather than deny: a guess is not a policy violation, and refusing every
      // `$(…)` would re-introduce exactly the class of false refusal this matcher exists to avoid.
      // The literal check above still ran, and the authoritative wall (read scope + prompt + verdict
      // redaction) does not depend on this matcher.
      warn(`holdout guard: could not resolve command targets (runtime expansion) — allowed, unaudited: ${cmd.slice(0, 160)}`);
      return null;
    }
    const hit = pathOperands(segments).find((op) => globHitsArtifact(op, workspace));
    return hit === undefined ? null : denyTarget("Command operand", hit);
  };
  const DENY_ROOT =
    "Search is rooted at a holdout-bearing dir (it contains .sparra) — pass an explicit non-holdout subdir path like src/ instead.";
  return (tool, input) => {
    const i = input as
      | { file_path?: string; path?: string; pattern?: string; glob?: string; command?: string }
      | undefined;
    if (tool === "Read") {
      const target = i?.file_path ?? i?.path;
      if (target && blockedReadTarget(target)) return denyTarget("Read target", target);
    }
    if (tool === "Grep") {
      // Content `pattern` is never inspected; deny only on the search root or a path-shaped filter.
      const root = resolve(i?.path ?? workspace);
      if (i?.glob) {
        if (globHitsArtifact(i.glob, root)) return denyTarget("Grep glob", i.glob);
      } else if (blockedSearchRoot(root)) return DENY_ROOT;
    }
    if (tool === "Glob") {
      // The pattern IS path-shaped — decide on the targets it resolves to, not the root shape.
      const root = resolve(i?.path ?? workspace);
      if (i?.pattern) {
        if (globHitsArtifact(i.pattern, root)) return denyTarget("Glob pattern", i.pattern);
      } else if (blockedSearchRoot(root)) return DENY_ROOT; // pattern-less Glob → fall back to the root rule
    }
    if (tool === "Bash") return bashDenial(i?.command ?? "");
    return null;
  };
}
