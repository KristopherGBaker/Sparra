import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Paths, SPARRA_GITIGNORE } from "../src/paths.ts";
import { StateStore } from "../src/state.ts";
import { defaultConfig } from "../src/config.ts";
import { holdoutFreeCwd } from "../src/build/readscope.ts";
import { cmdInit } from "../src/phases/init.ts";
import type { Ctx } from "../src/context.ts";

/**
 * Unit 1 — the Sparra-owned nested `.sparra/.gitignore`: a write-if-absent, fail-closed allowlist
 * generated at the shared `ensureScaffold` choke point (so init/new/finish all inherit it). Every
 * test uses a THROWAWAY temp git repo + temp `.sparra` — no live model, no network, temp-dir only.
 * Fixture/`git check-ignore` style mirrors `test/evalWorktree.test.ts`; the holdout-wall test
 * mirrors `test/holdoutCwd.test.ts`.
 */

/** Real git worktree/check-ignore ops under parallel-suite load can exceed vitest's 5s default;
 *  this per-test timeout is headroom for spawn contention, not a retry. */
const GIT_IT = 20_000;

function g(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

/** True iff git IGNORES `rel` in the repo at `dir` (`check-ignore -q` exits 0 when ignored). */
function isIgnored(dir: string, rel: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "-q", rel], { cwd: dir });
    return true; // exit 0 → ignored
  } catch {
    return false; // exit 1 → NOT ignored (trackable)
  }
}

/** A throwaway git repo with NO top-level `.sparra/` ignore, scaffolded via `ensureScaffold`
 *  (the real choke point) so the nested allowlist `.gitignore` is what we generated. */
async function makeRepo(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-gitignore-"));
  g(dir, ["init"]);
  const paths = new Paths(dir);
  await paths.ensureScaffold();
  return dir;
}

// Durable set that MUST be trackable (allowlisted). `.gitignore` uses paths under `.sparra/`.
const DURABLE = [".gitignore", "config.yaml", "prompts/p.md", "prompts/.baseline.json", "calibration/good/x.json"];
// Volatile + one arbitrary FUTURE name — all MUST stay ignored by construction.
const VOLATILE = [
  "state.json",
  "environment.md",
  "memory.md",
  "frozen/HOLDOUT.frozen.md",
  "verdicts/v.json",
  "traces/t/x.jsonl",
  "conduct/run/run.json",
  "runs/r.json",
  "somefuturedir/file",
];

describe("Sparra-owned nested .sparra/.gitignore — fail-closed allowlist", () => {
  it("exists after scaffold and its first effective rule ignores '*'", async () => {
    const dir = await makeRepo();
    const gi = path.join(dir, ".sparra", ".gitignore");
    expect(fs.existsSync(gi)).toBe(true);
    const lines = fs
      .readFileSync(gi, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    expect(lines[0]).toBe("*"); // first effective (non-comment) rule is ignore-all
    fs.rmSync(dir, { recursive: true, force: true });
  }, GIT_IT);

  it("keeps the durable set (.gitignore/config.yaml/prompts/**/calibration/**) TRACKABLE", async () => {
    const dir = await makeRepo();
    for (const f of DURABLE) {
      expect(isIgnored(dir, path.join(".sparra", f))).toBe(false); // trackable
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }, GIT_IT);

  it("ignores every volatile artifact AND an arbitrary future dir (no per-dir rule)", async () => {
    const dir = await makeRepo();
    for (const f of VOLATILE) {
      expect(isIgnored(dir, path.join(".sparra", f))).toBe(true); // ignored
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }, GIT_IT);

  it("the real `sparra init` phase (cmdInit) writes the nested allowlist .gitignore", async () => {
    // Drives the CLI init entry directly (not just ensureScaffold) so the whole init code path is
    // proven to emit the file — init/new/finish all share the ensureScaffold choke point.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-init-"));
    g(dir, ["init"]);
    await cmdInit(dir, { mode: "existing" });
    const gi = path.join(dir, ".sparra", ".gitignore");
    expect(fs.existsSync(gi)).toBe(true);
    expect(fs.readFileSync(gi, "utf8")).toBe(SPARRA_GITIGNORE);
    // config.yaml is trackable, state.json is ignored — the durable/volatile split is live post-init.
    expect(isIgnored(dir, path.join(".sparra", "config.yaml"))).toBe(false);
    expect(isIgnored(dir, path.join(".sparra", "state.json"))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  }, GIT_IT);

  it("write-if-absent: a pre-existing user-edited .sparra/.gitignore survives byte-for-byte", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-gitignore-preexist-"));
    g(dir, ["init"]);
    const paths = new Paths(dir);
    // Pre-create .sparra/ with a custom one-line .gitignore BEFORE any scaffold.
    fs.mkdirSync(paths.dir, { recursive: true });
    const custom = "# my hand-edited ignore\n*.tmp\n";
    fs.writeFileSync(paths.gitignore, custom);
    await paths.ensureScaffold(); // must NOT clobber
    expect(fs.readFileSync(paths.gitignore, "utf8")).toBe(custom);
    fs.rmSync(dir, { recursive: true, force: true });
  }, GIT_IT);

  it("allowlist pin: the generated template NEVER re-includes frozen/, verdicts/, or traces/", () => {
    // Guard against a future edit that widens the allowlist to a holdout-bearing dir. This fails
    // if someone appends e.g. `!/frozen/` + `!/frozen/**` (mutation 5c).
    for (const forbidden of ["frozen", "verdicts", "traces"]) {
      expect(SPARRA_GITIGNORE).not.toMatch(new RegExp(`^!\\/${forbidden}\\/`, "m"));
    }
    // Positive control: the durable set IS re-included, so the pin isn't vacuously green.
    for (const allowed of ["config\\.yaml", "prompts", "calibration"]) {
      expect(SPARRA_GITIGNORE).toMatch(new RegExp(`^!\\/${allowed}`, "m"));
    }
  });
});

describe("holdout wall — a worktree with TRACKED .sparra/config.yaml stays holdout-free", () => {
  it("holdoutFreeCwd returns the worktree; it carries tracked config but no holdout .sparra artifact", async () => {
    // Build a repo that TRACKS the durable .sparra set (config.yaml), commit, then add a git
    // worktree — the terraform-style shared-config scenario. The nested allowlist keeps the
    // holdout-bearing .sparra content (state.json, frozen/HOLDOUT.frozen.md, verdicts/) UNtracked,
    // so the worktree checked out from that commit is holdout-free.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-hw-root-"));
    g(root, ["init"]);
    const paths = new Paths(root);
    await paths.ensureScaffold();
    // Durable config (allowlisted) + real holdout-bearing .sparra artifacts (must stay untracked).
    fs.writeFileSync(paths.config, "backends: {}\n");
    fs.writeFileSync(paths.state, '{"phase":"build","abs":"/Users/someone/machine-local"}\n');
    fs.writeFileSync(paths.frozenHoldout, "# Frozen holdout\n\n- output must be byte-identical.\n");
    fs.writeFileSync(path.join(paths.verdicts, "v.json"), "{}\n");
    // git add respects the nested .gitignore, so only the allowlisted set is staged.
    g(root, ["add", "-A"]);
    g(root, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "base"]);

    // config.yaml rides git; NO holdout-bearing .sparra path is ever tracked.
    const tracked = g(root, ["ls-files"]).split("\n").filter(Boolean);
    expect(tracked).toContain(".sparra/config.yaml");
    expect(tracked.some((f) => f.startsWith(".sparra/") && !DURABLE.some((d) => f === `.sparra/${d}` || f.startsWith(`.sparra/${d.split("/")[0]}/`)))).toBe(false);
    expect(tracked).not.toContain(".sparra/state.json");
    expect(tracked).not.toContain(".sparra/frozen/HOLDOUT.frozen.md");

    // Add a worktree checked out from that commit — it carries the tracked config.yaml only.
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-hw-wt-"));
    fs.rmSync(wt, { recursive: true, force: true }); // git worktree add needs a non-existent path
    g(root, ["worktree", "add", "-q", "--detach", wt]);
    try {
      // The worktree carries config.yaml but no holdout artifact.
      expect(fs.existsSync(path.join(wt, ".sparra", "config.yaml"))).toBe(true);
      expect(fs.existsSync(path.join(wt, ".sparra", "state.json"))).toBe(false);
      expect(fs.existsSync(path.join(wt, ".sparra", "frozen", "HOLDOUT.frozen.md"))).toBe(false);

      const store = StateStore.create(paths, "existing");
      const ctx: Ctx = { root, paths, config: defaultConfig(), store };
      // holdoutFreeCwd keeps the worktree (no holdout artifact WITHIN it).
      expect(holdoutFreeCwd(ctx, wt)).toBe(wt);
    } finally {
      g(root, ["worktree", "remove", "--force", wt]);
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(wt, { recursive: true, force: true });
    }
  }, GIT_IT);
});
