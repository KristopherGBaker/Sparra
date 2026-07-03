import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { holdoutSection, assertNoHoldoutLeak, makeHoldoutReadDecider } from "../src/build/holdout.ts";
import { Paths } from "../src/paths.ts";
import { StateStore } from "../src/state.ts";
import { defaultConfig } from "../src/config.ts";
import type { Ctx } from "../src/context.ts";

describe("holdoutSection", () => {
  it("is empty when there is no holdout", () => {
    expect(holdoutSection("")).toBe("");
    expect(holdoutSection("   ")).toBe("");
  });
  it("labels the holdout for the evaluator and marks failures blocking", () => {
    const s = holdoutSection("- Entering a 6-digit code logs in within 2 seconds.");
    expect(s).toMatch(/HOLDOUT ACCEPTANCE CHECKS/);
    expect(s).toMatch(/BLOCKING/);
    expect(s).toContain("6-digit code");
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
    expect(deny("Glob", { pattern: ".sparra/**" })).toBeTruthy(); // .sparra segment
    expect(deny("Glob", { pattern: "{README.md,.sparra/HOLDOUT.md}" })).toBeTruthy(); // one bad alternative
    expect(deny("Glob", { pattern: "**/*" })).toBeTruthy(); // unbounded ** descends into .sparra
    expect(deny("Glob", { pattern: "**/*.md" })).toBeTruthy(); // ditto
    expect(deny("Glob", { pattern: "*/**/*.md" })).toBeTruthy(); // a ** anywhere still recurses into an artifact
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
    fs.rmSync(root, { recursive: true, force: true });
  });
});
