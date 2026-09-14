import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { holdoutSection, assertNoHoldoutLeak, makeHoldoutReadDecider, holdoutId, renderRetiredHoldouts, parseRetiredHoldouts, RETIRED_HOLDOUT_MARKER } from "../src/build/holdout.ts";
import { Paths } from "../src/paths.ts";
import { StateStore } from "../src/state.ts";
import { defaultConfig } from "../src/config.ts";
import type { Ctx } from "../src/context.ts";

describe("holdoutSection", () => {
  it("is empty when there is no holdout", () => {
    expect(holdoutSection("")).toBe("");
    expect(holdoutSection("   ")).toBe("");
  });
  it("labels the holdout for the evaluator and marks failures blocking, AND states the CONTRACT-CONTRADICTED carve-out (both halves)", () => {
    const s = holdoutSection("- Entering a 6-digit code logs in within 2 seconds.");
    expect(s).toMatch(/HOLDOUT ACCEPTANCE CHECKS/);
    expect(s).toMatch(/BLOCKING/);
    expect(s).toContain("6-digit code");
    // U3 — the wall still declares failures blocking (half 1) AND states the VALID contradiction
    // exception (half 2): flag CONTRACT-CONTRADICTED with a verbatim clause; "inconvenient" never qualifies.
    expect(s).toContain("regardless of rubric score"); // half 1: still absolute-blocking by default
    expect(s).toContain("CONTRACT-CONTRADICTED"); // half 2: the carve-out
    expect(s).toMatch(/holdoutContradictions/);
    expect(s).toMatch(/verbatim/i);
    expect(s).toMatch(/[Ii]nconvenient/);
  });
});

describe("holdoutId / retirement record (de)serialization (U3)", () => {
  const H = "The executable must NOT import the SumiKit module under any circumstances whatsoever.";

  it("holdoutId is stable, short, holdout-safe, and distinguishes distinct holdouts", () => {
    const a = holdoutId(H);
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(holdoutId(H)).toBe(a); // stable
    expect(holdoutId(`  ${H.toUpperCase()}  `)).toBe(a); // normalized (case/whitespace-insensitive)
    expect(holdoutId("A completely different holdout check about login timing.")).not.toBe(a);
    expect(a).not.toContain("SumiKit"); // reveals no holdout text
  });

  it("render → parse round-trips a retirement record (holdout-safe: id + clause only)", () => {
    const rec = { holdoutId: holdoutId(H), contractClause: "The artifact MUST import and use SumiKit for drawing.", reason: "forbids a mandate" };
    const rendered = renderRetiredHoldouts([rec]);
    expect(rendered).toContain(RETIRED_HOLDOUT_MARKER);
    expect(rendered).not.toContain("SumiKit module under"); // no holdout text
    const parsed = parseRetiredHoldouts(rendered);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.holdoutId).toBe(rec.holdoutId);
    expect(parsed[0]!.contractClause).toContain("import and use SumiKit");
    expect(renderRetiredHoldouts([])).toBe(""); // empty → nothing
  });
});

describe("assertNoHoldoutLeak (the code-enforced isolation wall)", () => {
  const holdout = "- Entering a 6-digit code logs in within 2 seconds.\n- Tapping logout clears the session token.";

  it("does nothing when there is no holdout", () => {
    expect(() => assertNoHoldoutLeak("generator", "any prompt with the 6-digit code text", "")).not.toThrow();
  });

  it("does nothing when the prompt is clean", () => {
    expect(() => assertNoHoldoutLeak("generator", "Build a login screen per the contract.", holdout)).not.toThrow();
  });

  it("throws if a substantive holdout line leaks into the builder prompt", () => {
    const leaky = "Build it.\nAlso make sure: Entering a 6-digit code logs in within 2 seconds.\n";
    expect(() => assertNoHoldoutLeak("generator", leaky, holdout)).toThrow(/Holdout leaked into the generator/);
  });

  it("ignores short/structural lines (no false positives on markers)", () => {
    const h = "## Checks\n- ok\n";
    expect(() => assertNoHoldoutLeak("contract-generator", "## Checks\n- ok\nbuild the thing", h)).not.toThrow();
  });
});

/**
 * U2 — the read decider decides on RESOLVED PATHS, not tool-input substrings. A Grep content regex
 * or a Glob filename that merely mentions "holdout" (legitimate source like `src/build/holdout.ts`)
 * must NOT be blocked, while real reads of a protected artifact still are. Every allowed/blocked
 * form in the contract (#4–#12) gets a case here. The decider is pure path logic (no disk reads),
 * so the workspace root is the anchor.
 */
async function makeDeciderCtx(): Promise<{ ctx: Ctx; root: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-decider-"));
  const paths = new Paths(root);
  await paths.ensureScaffold();
  const store = StateStore.create(paths, "greenfield");
  const ctx: Ctx = { root, paths, config: defaultConfig(), store };
  fs.writeFileSync(paths.holdout, "# Holdout\n\n- The output must be byte-identical to the source.\n");
  fs.writeFileSync(paths.frozenHoldout, "# Holdout\n\n- The output must be byte-identical to the source.\n");
  return { ctx, root };
}

/** Fix round 3 — a REALISTIC `.sparra`-shaped fixture tree, populated with an actual on-disk file at
 *  every artifact-producing shape (not merely a placeholder path string): the fixed constants
 *  (config.yaml/state.json/memory.md) AND the dynamically-named shapes a real build/reflect run
 *  produces (a trace file, a proposals file, a nested reflect summary, a contract, a verdict). The
 *  guard itself is pure path logic (no disk reads) — this fixture exists so the deny/allow pairs below
 *  are tested against genuine artifact PATHS, not hand-picked example strings baked into the test. */
async function makeMatureDeciderCtx(): Promise<{ ctx: Ctx; root: string }> {
  const { ctx, root } = await makeDeciderCtx();
  const { paths } = ctx;
  fs.writeFileSync(paths.config, "build: {}\n");
  fs.writeFileSync(paths.state, "{}\n");
  fs.writeFileSync(paths.memory, "# Memory\n");
  fs.writeFileSync(paths.contractFile("item-001"), "# Contract\n");
  fs.mkdirSync(path.dirname(paths.verdictFile("item-001", 1)), { recursive: true });
  fs.writeFileSync(paths.verdictFile("item-001", 1), "# Verdict\n");
  const traceDir = paths.traceDir("run-001");
  fs.mkdirSync(traceDir, { recursive: true });
  fs.writeFileSync(path.join(traceDir, "01-generator.md"), "# generator trace\n");
  fs.writeFileSync(path.join(traceDir, "02-evaluator.md"), "# evaluator trace (holdout-derived)\n");
  fs.mkdirSync(paths.proposals, { recursive: true });
  fs.writeFileSync(path.join(paths.proposals, "item-001-1.md"), "# Proposal\n");
  const reflectDir = path.join(paths.reflect, "20260710-000000");
  fs.mkdirSync(reflectDir, { recursive: true });
  fs.writeFileSync(path.join(reflectDir, "SUMMARY.md"), "# Reflect summary\n");
  return { ctx, root };
}

describe("makeHoldoutReadDecider — path-based, not substring (U2)", () => {
  it("#4/#7 Bash referencing legitimate holdout SOURCE (not a protected artifact) is allowed", async () => {
    const { ctx, root } = await makeDeciderCtx();
    const deny = makeHoldoutReadDecider(ctx, root);
    expect(deny("Bash", { command: 'rg -n "redactHoldout|assertNoHoldoutLeak" src/build/holdout.ts' })).toBeNull();
    expect(deny("Bash", { command: "cat src/build/holdout.ts" })).toBeNull();
    expect(deny("Bash", { command: "npx vitest run test/holdout.test.ts" })).toBeNull();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("#5 Grep never inspects the content pattern; a subdir root + innocent glob filter is allowed", async () => {
    const { ctx, root } = await makeDeciderCtx();
    const deny = makeHoldoutReadDecider(ctx, root);
    const pattern = "redactHoldout|assertNoHoldoutLeak";
    expect(deny("Grep", { pattern, path: path.join(root, "src") })).toBeNull();
    expect(deny("Grep", { pattern, path: path.join(root, "src"), glob: "*.ts" })).toBeNull();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("#6 innocent brace Glob is allowed identically WITH a path and PATHLESS at the holdout-bearing cwd", async () => {
    const { ctx, root } = await makeDeciderCtx();
    const deny = makeHoldoutReadDecider(ctx, root); // workspace = root, which holds .sparra
    const pattern = "{CLAUDE.md,docs/build-loop.md,skills/sparra/subskills/diagnose.md}";
    expect(deny("Glob", { pattern, path: root })).toBeNull();
    expect(deny("Glob", { pattern })).toBeNull(); // pathless → identical resolved targets → identical decision
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("#8 Read of a holdout artifact (file, frozen, anything under .sparra, the explicitPath) is denied", async () => {
    const { ctx, root } = await makeDeciderCtx();
    const deny = makeHoldoutReadDecider(ctx, root);
    expect(deny("Read", { file_path: ctx.paths.holdout })).toBeTruthy();
    expect(deny("Read", { file_path: ctx.paths.frozenHoldout })).toBeTruthy();
    expect(deny("Read", { file_path: ".sparra/HOLDOUT.md" })).toBeTruthy(); // relative → under .sparra
    expect(deny("Read", { file_path: ".sparra/frozen/HOLDOUT.frozen.md" })).toBeTruthy();
    expect(deny("Read", { file_path: path.join(root, ".sparra/verdicts/item-001.r1.verdict.md") })).toBeTruthy();
    expect(deny("Read", { file_path: path.join(root, "src/App.ts") })).toBeNull(); // ordinary read allowed
    // An explicit holdout path OUTSIDE .sparra is protected by file + basename.
    const explicit = path.join(root, "acceptance/CHECKS.md");
    const denyEx = makeHoldoutReadDecider(ctx, root, explicit);
    expect(denyEx("Read", { file_path: explicit })).toBeTruthy();
    expect(denyEx("Glob", { pattern: "**/CHECKS.md" })).toBeTruthy(); // explicitPath basename named
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("#9/#14 Grep rooted AT/UNDER/ABOVE a holdout artifact is denied with an actionable message", async () => {
    const { ctx, root } = await makeDeciderCtx();
    const deny = makeHoldoutReadDecider(ctx, root); // cwd = root (contains .sparra)
    expect(deny("Grep", { path: path.join(root, ".sparra"), pattern: "x" })).toBeTruthy(); // AT
    expect(deny("Grep", { path: path.join(root, ".sparra/verdicts"), pattern: "x" })).toBeTruthy(); // UNDER
    expect(deny("Grep", { path: root, pattern: "x" })).toBeTruthy(); // ABOVE (contains .sparra)
    const pathless = deny("Grep", { pattern: "byte-identical" }); // pathless → cwd = root
    expect(pathless).toBeTruthy();
    expect(pathless).toMatch(/src\//); // #14 tells the role to pass an explicit non-holdout subdir
    expect(deny("Grep", { path: path.join(root, "src"), pattern: "x" })).toBeNull(); // subdir is fine
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("#10 Glob patterns that name/escape-into/recurse-into an artifact are denied; innocent ones allowed", async () => {
    const { ctx, root } = await makeDeciderCtx();
    const deny = makeHoldoutReadDecider(ctx, root);
    expect(deny("Glob", { pattern: "**/HOLDOUT.md", path: root })).toBeTruthy(); // basename named
    expect(deny("Glob", { pattern: "**/HOLDOUT.md" })).toBeTruthy(); // pathless above root, same decision
    expect(deny("Glob", { pattern: "**/HOLDOUT.frozen.md" })).toBeTruthy();
    expect(deny("Glob", { pattern: "**/HOLD*" })).toBeTruthy();
    expect(deny("Glob", { pattern: "**/*OUT.md" })).toBeTruthy();
    expect(deny("Glob", { pattern: "**/HOLDOUT.*" })).toBeTruthy();
    expect(deny("Glob", { pattern: ".sparra/**" })).toBeTruthy(); // .sparra segment
    expect(deny("Glob", { pattern: "{README.md,.sparra/HOLDOUT.md}" })).toBeTruthy(); // one bad alternative
    expect(deny("Glob", { pattern: "**/*" })).toBeTruthy(); // unbounded ** descends into .sparra
    expect(deny("Glob", { pattern: "**/*.md" })).toBeTruthy(); // ditto
    expect(deny("Glob", { pattern: "*/**/*.md" })).toBeTruthy(); // a ** anywhere still recurses into an artifact
    expect(deny("Glob", { pattern: "**/vitest.config.*", path: root })).toBeNull();
    expect(deny("Glob", { pattern: "**/vitest.config.*", path: "." })).toBeNull();
    expect(deny("Glob", { pattern: "**/vitest.config.*" })).toBeNull();
    expect(deny("Glob", { pattern: "**/{vitest.config.*,HOLDOUT.md}" })).toBeTruthy();
    expect(deny("Glob", { path: path.join(root, "src"), pattern: "../.sparra/frozen/HOLDOUT.frozen.md" })).toBeTruthy(); // .. escape
    expect(deny("Glob", { pattern: ctx.paths.frozenHoldout })).toBeTruthy(); // absolute prefix → the artifact
    expect(deny("Glob", { path: path.join(root, "src"), pattern: "*.ts" })).toBeNull(); // innocent subdir glob
    expect(deny("Glob", { pattern: "docs/*.md" })).toBeNull(); // single-level, no artifact
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("#11 Bash referencing a protected artifact path/basename or hidden-glob evasion is denied", async () => {
    const { ctx, root } = await makeDeciderCtx();
    const deny = makeHoldoutReadDecider(ctx, root);
    expect(deny("Bash", { command: "cat .sparra/HOLDOUT.md" })).toBeTruthy(); // .sparra + basename
    expect(deny("Bash", { command: `cat ${ctx.paths.holdout}` })).toBeTruthy(); // absolute → basename
    expect(deny("Bash", { command: "grep -r secret .sparra" })).toBeTruthy(); // .sparra token
    expect(deny("Bash", { command: "cat .s*/HOLDOUT.md" })).toBeTruthy(); // hidden-glob
    expect(deny("Bash", { command: "cat .*/H*" })).toBeTruthy(); // hidden-glob
    expect(deny("Bash", { command: "npm test" })).toBeNull();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("#12 Grep with a file filter naming a protected artifact is denied even with an innocent pattern", async () => {
    const { ctx, root } = await makeDeciderCtx();
    const deny = makeHoldoutReadDecider(ctx, root);
    expect(deny("Grep", { pattern: "x", path: path.join(root, "src"), glob: "**/HOLDOUT.md" })).toBeTruthy();
    expect(deny("Grep", { pattern: "x", path: path.join(root, "src"), glob: ".sparra/**" })).toBeTruthy();
    expect(deny("Grep", { pattern: "x", path: root, glob: "**/vitest.config.*" })).toBeNull();
    expect(deny("Grep", { pattern: "x", glob: "**/vitest.config.*" })).toBeNull();
    // The message NAMES the offending target and the real reason (it used to be one fixed string
    // suggesting `src/` and `**/vitest.config.*` — JS boilerplate, and useless in, say, a Swift repo).
    expect(deny("Grep", { pattern: "x", path: root, glob: "**/*.md" })).toContain("**/*.md");
    expect(deny("Grep", { pattern: "x", path: root, glob: "**/*OUT.md" })).toContain("evaluator-only artifacts");
    const unsafeRoot = deny("Grep", { pattern: "x", path: root });
    const protectedTarget = deny("Grep", { pattern: "x", path: root, glob: "**/HOLDOUT.*" });
    expect(unsafeRoot).toContain("rooted");
    expect(protectedTarget).toContain("evaluator-only artifacts");
    fs.rmSync(root, { recursive: true, force: true });
  });

  // U2 Gap A — a wildcard DIRECTORY segment that descends into .sparra enumerates filenames beneath
  // it even when it matches no top-level artifact and is not globstar. The allow/deny pairs below fail
  // against the pre-fix code (the mid-depth denials were allowed), so they are non-degenerate.
  it("#1/#2 Glob with a wildcard-dir segment descending into .sparra is denied", async () => {
    const { ctx, root } = await makeDeciderCtx();
    const deny = makeHoldoutReadDecider(ctx, root);
    for (const pattern of [".s*/verdicts/*", ".s*/traces/*", ".s*/*", ".s*/**", ".s*"])
      expect(deny("Glob", { pattern }), pattern).toBeTruthy();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("#3 innocent globs whose wildcard tail never traverses into .sparra are allowed", async () => {
    const { ctx, root } = await makeDeciderCtx();
    const deny = makeHoldoutReadDecider(ctx, root);
    expect(deny("Glob", { pattern: "docs/*.md" })).toBeNull();
    expect(deny("Glob", { pattern: "src/**/*.ts" })).toBeNull();
    expect(deny("Glob", { pattern: "*.json" })).toBeNull();
    expect(deny("Glob", { pattern: ".git/*" })).toBeNull();
    fs.rmSync(root, { recursive: true, force: true });
  });

  // Fix round 2 (#2/#4) — a recursive globstar naming a REAL protected filename SHAPE (not merely
  // a fake placeholder) must stay denied even though it never matches the `.sparra` dir itself or an
  // explicit holdout path. Each pattern here matches a genuine artifact under `.sparra` (config.yaml,
  // state.json, memory.md, a contract file, a verdict file) — the pre-fix representative-example list
  // let every one of these through, so this pair is non-degenerate. `**/vitest.config.*` — a basename
  // with no real `.sparra` counterpart — must remain the sole allow case, both for Glob and for Grep's
  // `glob:` filter (the two share `globHitsArtifact`).
  it("#2/#4 recursive globs naming real .sparra artifact shapes stay denied; vitest.config.* stays allowed", async () => {
    const { ctx, root } = await makeDeciderCtx();
    const deny = makeHoldoutReadDecider(ctx, root);
    const realShapeDenies = [
      "**/*.verdict.md",
      "**/config.yaml",
      "**/*.yaml",
      "**/state.json",
      "**/memory.md",
      "**/*.contract.md",
    ];
    for (const pattern of realShapeDenies) {
      expect(deny("Glob", { pattern, path: root }), pattern).toBeTruthy();
      expect(deny("Grep", { pattern: "x", path: root, glob: pattern }), pattern).toBeTruthy();
    }
    expect(deny("Glob", { pattern: "**/vitest.config.*", path: root })).toBeNull();
    expect(deny("Grep", { pattern: "x", path: root, glob: "**/vitest.config.*" })).toBeNull();
    fs.rmSync(root, { recursive: true, force: true });
  });

  // Fix round 3 — the hand-maintained-example-list pivot. A REALISTIC, mature `.sparra` tree (real
  // trace, proposals, and nested reflect files on disk, plus the fixed config/state/memory/contract/
  // verdict artifacts) is checked against every pattern the round-3 brief demonstrated still leaking
  // (a Grep `glob: "**/traces/**/*.md"` returned the un-redacted evaluator trace lines) PLUS the full
  // round-1 set, for BOTH Glob and Grep's `glob:` filter (shared `globHitsArtifact`). `vitest.config.*`
  // remains the sole required positive fixture. Non-degenerate: every deny pattern here is checked
  // against the SAME mature tree the allow pattern is checked against, and two of them (the trace-file
  // and proposals-file cases) were independently mutation-tested by temporarily disabling the new
  // `matchGlobPrefix` structural-descent check, confirming both go from denied to allowed (red).
  it("fix round 3: trace/proposals/reflect/item- shapes stay denied on a mature .sparra tree; vitest.config.* stays allowed", async () => {
    const { ctx, root } = await makeMatureDeciderCtx();
    const deny = makeHoldoutReadDecider(ctx, root);
    const stillLeakingDenies = [
      "**/*-evaluator.md", // the exact shape the round-3 Grep probe surfaced (NN-evaluator.md)
      "**/*-generator.md",
      "**/traces/**/*.md", // the demonstrated Grep glob: leak (un-redacted evaluator transcript)
      "**/proposals/*.md",
      "**/item-*.md",
      "**/reflection.md",
      "**/reflect/*.md",
    ];
    const round1Denies = ["**/*.verdict.md", "**/config.yaml", "**/*.yaml", "**/state.json", "**/memory.md", "**/*.contract.md"];
    for (const pattern of [...stillLeakingDenies, ...round1Denies]) {
      expect(deny("Glob", { pattern, path: root }), pattern).toBeTruthy();
      expect(deny("Grep", { pattern: "x", path: root, glob: pattern }), pattern).toBeTruthy();
    }
    expect(deny("Glob", { pattern: "**/vitest.config.*", path: root })).toBeNull();
    expect(deny("Grep", { pattern: "x", path: root, glob: "**/vitest.config.*" })).toBeNull();
    // A literal directory segment ahead of the tail is NEVER exempted, even if the tail alone would be
    // (the `hasProvablySafeTail` carve-out only fires for pure `**`-then-tail patterns).
    expect(deny("Glob", { pattern: "**/traces/vitest.config.*", path: root })).toBeTruthy();
    fs.rmSync(root, { recursive: true, force: true });
  });

  // U2 Gap B — the direct path/basename Bash checks are case-insensitive so a lowercase name reads
  // the real artifact on a case-insensitive FS. The allow cases still pass (exact basename, not a bare
  // "holdout" substring), so the pair is non-degenerate.
  it("#4/#5 Bash referencing a holdout basename/.sparra is denied case-insensitively", async () => {
    const { ctx, root } = await makeDeciderCtx();
    const deny = makeHoldoutReadDecider(ctx, root);
    expect(deny("Bash", { command: "cat holdout.md" })).toBeTruthy(); // NEW: lowercase basename
    expect(deny("Bash", { command: "cat Holdout.MD" })).toBeTruthy(); // NEW: mixed case
    expect(deny("Bash", { command: "ls .Sparra" })).toBeTruthy(); // NEW: mixed-case .sparra
    expect(deny("Bash", { command: "cat HOLDOUT.md" })).toBeTruthy(); // exact-case, unchanged
    expect(deny("Bash", { command: "ls .sparra" })).toBeTruthy(); // exact-case, unchanged
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("#6 Bash with legit source / prose (not an exact holdout basename) stays allowed", async () => {
    const { ctx, root } = await makeDeciderCtx();
    const deny = makeHoldoutReadDecider(ctx, root);
    expect(deny("Bash", { command: "cat src/build/holdout.ts" })).toBeNull();
    expect(deny("Bash", { command: "grep redactHoldout src" })).toBeNull();
    expect(deny("Bash", { command: "cat foo.test.ts" })).toBeNull();
    expect(deny("Bash", { command: "echo holdout is redacted" })).toBeNull();
    fs.rmSync(root, { recursive: true, force: true });
  });
});

// ── Field report 2026-09-14 (Sarukani, contract-generator): commands that touched NOTHING the wall
// protects were refused as policy violations, each with the same "evaluator-only artifacts" text. The
// matcher decided on raw command TEXT: `*.md` in ANY token could match the basename `HOLDOUT.md`
// (directory-agnostic), and ` .*` inside a REGEX argument read as a dotfile glob. ──────────────────
describe("makeHoldoutReadDecider — Bash decides on resolved path OPERANDS, not command text", () => {
  /** A project-shaped workspace: real dirs, a root-level holdout, `.sparra/` beside it. */
  async function realProject() {
    const { ctx, root } = await makeDeciderCtx();
    for (const d of ["docs", "Packages", "Apps"]) fs.mkdirSync(path.join(root, d), { recursive: true });
    return { deny: makeHoldoutReadDecider(ctx, root), ctx, root };
  }

  it("allows the four field-report commands — a glob under docs/ and a regex that looks like a dotglob", async () => {
    const { deny, root } = await realProject();
    for (const command of [
      `rg -n '458' CLAUDE.md AGENTS.md docs/*.md | head`,
      `rg -n "catalogue" docs/*.md CLAUDE.md AGENTS.md | head -40`,
      `rg -n "never met|actually been taught" docs/*.md Packages/SarukaniKit/Sources --glob '!*.json' | head -40`,
      `rg -n '^## §' docs/DECISIONS.md | tail -5; rg -n '^#+ .*§(8[0-9])' docs/DECISIONS.md | tail -5`,
    ])
      expect(deny("Bash", { command })).toBeNull();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("still denies a command that genuinely targets the artifacts — by path, wildcard or dotglob", async () => {
    const { deny, root, ctx } = await realProject();
    // The reported-safe case must stay refused: a command reaching into `.sparra/verdicts/`.
    expect(deny("Bash", { command: "cat .sparra/verdicts/item-001.r1.verdict.md" })).toBeTruthy();
    expect(deny("Bash", { command: `wc -l ${ctx.paths.holdout}` })).toBeTruthy(); // absolute path
    expect(deny("Bash", { command: "cat HOLDOUT.*" })).toBeTruthy(); // wildcard-basename evasion
    expect(deny("Bash", { command: "cat .*" })).toBeTruthy(); // dotglob reaching `.sparra`
    expect(deny("Bash", { command: "cat .s*/frozen/HOLDOUT.frozen.md" })).toBeTruthy();
    // A root-level `find -name '*.md'` really WOULD enumerate the holdout — directory-aware, so denied
    // here while the same `*.md` under docs/ is allowed above.
    expect(deny("Bash", { command: "find . -name '*.md'" })).toBeTruthy();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("names the offending operand and suggests paths from the project actually in play", async () => {
    const { deny, root } = await realProject();
    const msg = deny("Bash", { command: "cat HOLDOUT.*" })!;
    expect(msg).toContain("HOLDOUT.*"); // WHICH operand
    expect(msg).toContain("evaluator-only artifacts"); // WHY
    expect(msg).toMatch(/docs\/|Packages\/|Apps\//); // real dirs, not `src/` boilerplate
    expect(msg).not.toContain("vitest.config");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("ALLOWS (and audits) a command whose operands cannot be resolved, rather than calling it a violation", async () => {
    const { deny, root } = await realProject();
    // Runtime expansion: the operand list would be a guess, and a guess is not a policy verdict.
    expect(deny("Bash", { command: 'rg -n "x" "$(cat list.txt)"' })).toBeNull();
    expect(deny("Bash", { command: "rg -n x $DOCS_DIR" })).toBeNull();
    expect(deny("Bash", { command: `rg -n 'unbalanced docs/` })).toBeNull();
    // …but the LITERAL check still runs on the raw text, so an unresolvable command that NAMES a
    // protected artifact is still refused.
    expect(deny("Bash", { command: 'cat "$(echo .sparra)/verdicts/x.md"' })).toBeTruthy();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("does not mistake flags, regex patterns or the command word for paths", async () => {
    const { deny, root } = await realProject();
    for (const command of [
      "swift test 2>/dev/null | tail -5",
      "rg -n --glob '!*.json' 'HOLD.*' Packages", // --glob takes a VALUE, so `HOLD.*` is still the regex
      "rg --include=*.swift 'HOLDOUT' Packages", // the pattern may name the artifact; it reads nothing
      "sed -n '1,5p' docs/DECISIONS.md",
      "awk '/^#/ {print}' docs/DECISIONS.md",
      "ls Packages/SarukaniKit/StoreTests/*.swift",
    ])
      expect(deny("Bash", { command })).toBeNull();
    fs.rmSync(root, { recursive: true, force: true });
  });
});
