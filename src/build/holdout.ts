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

  // BEST-EFFORT, PATH-BASED Bash matcher. A shell on a backend with no FS sandbox can always read an
  // absolute path or assemble one from pieces (`cat ".sp""arra/…"`, an interpreter, etc.), so no
  // string check is airtight — the authoritative wall is that the holdout lives OUTSIDE the role's
  // cwd/read scope + the prompt wall + verdict redaction. We deny commands that reference a protected
  // artifact BY PATH: the `.sparra` dir (name or absolute), a protected basename (`HOLDOUT.md` /
  // `HOLDOUT.frozen.md` / the explicit holdout), a hidden-path glob (`.s*`, `.[a-z]*`, `.*`) that
  // could expand into the dotted `.sparra`, or a WILDCARD token whose segment matches a protected
  // basename (`cat HOLDOUT.*`, `head HOLD*`, `cat *OUT.md` — the same wildcard-basename evasion the
  // Glob path closes; without it a live holdout at `<root>/HOLDOUT.md` is read directly). We
  // deliberately do NOT block on a bare case-insensitive "holdout" substring — that false-blocked
  // legitimate source (`src/build/holdout.ts`, `redactHoldout`, `cat *.test.ts`); a command naming a
  // real holdout ARTIFACT (by literal path or matching wildcard) still trips the checks above.
  const hiddenGlob = /(?:^|[\s'"=:(<>|&/])\.[A-Za-z0-9_]*[*?[]/; // a dot-prefixed token containing a glob metachar
  const bashBlocked = (cmd: string): boolean => {
    // Case-insensitive on the direct path/basename substrings so a lowercase name on a
    // case-insensitive FS (`cat holdout.md`, `.SPARRA/…`) still reads the real artifact — blocked.
    const lc = cmd.toLowerCase();
    if (lc.includes(sparraDir.toLowerCase()) || lc.includes(sparraBase.toLowerCase())) return true;
    if ([...basenames].some((b) => lc.includes(b.toLowerCase()))) return true;
    if (hiddenGlob.test(cmd)) return true;
    for (const tok of cmd.split(/[\s;|&<>()'"=`]+/)) {
      if (tok && GLOB_META.test(tok) && tok.split("/").some(segNamesArtifact)) return true;
    }
    return false;
  };
  const DENY =
    "Pattern targets evaluator-only Holdout/.sparra artifacts — narrow it to a safe relative subtree or filename, such as src/ or **/vitest.config.*.";
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
      if (i?.glob) {
        if (globHitsArtifact(i.glob, root)) return DENY;
      } else if (blockedSearchRoot(root)) return DENY_ROOT;
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
