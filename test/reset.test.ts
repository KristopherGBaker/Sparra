import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { maybeResetWorkspace, realResetDeps, type ResetDeps, type ResetGateInput } from "../src/build/reset.ts";
import { recordAttempt, renderPriorAttempts, APPROACH_CAP, FAILURE_CAP } from "../src/build/attempts.ts";
import { TRUNCATION_MARKER } from "../src/build/feedback.ts";
import type { ItemState } from "../src/state.ts";

function makeItem(): ItemState {
  return { status: "building", round: 1, pivots: 0, criterionFailStreak: {} };
}

function fakeResetDeps(over: Partial<ResetDeps> = {}) {
  const calls = { restore: 0, clean: 0 };
  const deps: ResetDeps = {
    isGitRepo: () => true,
    hasHead: () => true,
    currentBranch: () => "sparra/run",
    restoreTracked: () => {
      calls.restore++;
    },
    cleanUntracked: () => {
      calls.clean++;
    },
    ...over,
  };
  return { deps, calls };
}

const gateInput = (over: Partial<ResetGateInput> = {}): ResetGateInput => ({
  workspaceDir: "/ws",
  persistedWorkspaceDir: "/ws",
  recordedBranch: "sparra/run",
  branchPrefix: "sparra/",
  resetWorkspaceEnabled: true,
  autoCommit: true,
  ...over,
});

const g = (dir: string, args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });

describe("maybeResetWorkspace — safety gates (each refuses with NO reset op)", () => {
  it("(c) pivot.resetWorkspace off → no reset", () => {
    const { deps, calls } = fakeResetDeps();
    expect(maybeResetWorkspace(gateInput({ resetWorkspaceEnabled: false }), deps).reset).toBe(false);
    expect(calls).toEqual({ restore: 0, clean: 0 });
  });
  it("(b) autoCommit off → no reset (HEAD isn't the item-start state)", () => {
    const { deps, calls } = fakeResetDeps();
    expect(maybeResetWorkspace(gateInput({ autoCommit: false }), deps).reset).toBe(false);
    expect(calls).toEqual({ restore: 0, clean: 0 });
  });
  it("(a) no recorded Sparra branch (in-place) → no reset", () => {
    const { deps, calls } = fakeResetDeps();
    expect(maybeResetWorkspace(gateInput({ recordedBranch: undefined }), deps).reset).toBe(false);
    expect(calls).toEqual({ restore: 0, clean: 0 });
  });
  it("workspace ≠ persisted build workspace → no reset", () => {
    const { deps, calls } = fakeResetDeps();
    expect(maybeResetWorkspace(gateInput({ persistedWorkspaceDir: "/other" }), deps).reset).toBe(false);
    expect(calls).toEqual({ restore: 0, clean: 0 });
  });
  it("(e) not a git tree → no reset", () => {
    const { deps, calls } = fakeResetDeps({ isGitRepo: () => false });
    expect(maybeResetWorkspace(gateInput(), deps).reset).toBe(false);
    expect(calls).toEqual({ restore: 0, clean: 0 });
  });
  it("no HEAD → no reset", () => {
    const { deps, calls } = fakeResetDeps({ hasHead: () => false });
    expect(maybeResetWorkspace(gateInput(), deps).reset).toBe(false);
    expect(calls).toEqual({ restore: 0, clean: 0 });
  });
  it("(f) detached HEAD → no reset", () => {
    const { deps, calls } = fakeResetDeps({ currentBranch: () => "HEAD" });
    expect(maybeResetWorkspace(gateInput(), deps).reset).toBe(false);
    expect(calls).toEqual({ restore: 0, clean: 0 });
  });
  it("(g) workspace branch ≠ recorded Sparra branch (stale record) → no reset", () => {
    const { deps, calls } = fakeResetDeps({ currentBranch: () => "sparra/OLD-run" });
    const r = maybeResetWorkspace(gateInput(), deps);
    expect(r.reset).toBe(false);
    if (!r.reset) expect(r.reason).toMatch(/recorded Sparra branch/);
    expect(calls).toEqual({ restore: 0, clean: 0 });
  });
  it("all gates hold → restore + clean run once each, {reset:true}", () => {
    const { deps, calls } = fakeResetDeps();
    expect(maybeResetWorkspace(gateInput(), deps).reset).toBe(true);
    expect(calls).toEqual({ restore: 1, clean: 1 });
  });
});

describe("maybeResetWorkspace — branch OWNERSHIP gate (git.branchPrefix)", () => {
  it("recorded branch without the Sparra prefix refuses — even when the live branch MATCHES it", () => {
    // The corrupted-state.json attack: state records "main", the workspace IS on "main",
    // every other gate holds. Ownership must still refuse.
    const { deps, calls } = fakeResetDeps({ currentBranch: () => "main" });
    const r = maybeResetWorkspace(gateInput({ recordedBranch: "main" }), deps);
    expect(r.reset).toBe(false);
    if (!r.reset) expect(r.reason).toMatch(/not Sparra-owned/);
    expect(calls).toEqual({ restore: 0, clean: 0 });
  });
  it("honors the CONFIGURED prefix, not a literal: prefix \"bot/\" accepts bot/x…", () => {
    const { deps, calls } = fakeResetDeps({ currentBranch: () => "bot/x" });
    const r = maybeResetWorkspace(gateInput({ recordedBranch: "bot/x", branchPrefix: "bot/" }), deps);
    expect(r.reset).toBe(true);
    expect(calls).toEqual({ restore: 1, clean: 1 });
  });
  it("…and prefix \"bot/\" refuses sparra/x (no hardcoded \"sparra/\")", () => {
    const { deps, calls } = fakeResetDeps({ currentBranch: () => "sparra/x" });
    const r = maybeResetWorkspace(gateInput({ recordedBranch: "sparra/x", branchPrefix: "bot/" }), deps);
    expect(r.reset).toBe(false);
    if (!r.reset) expect(r.reason).toMatch(/not Sparra-owned.*bot\//);
    expect(calls).toEqual({ restore: 0, clean: 0 });
  });
  it("empty prefix refuses (ownership is unverifiable)", () => {
    const { deps, calls } = fakeResetDeps({ currentBranch: () => "main" });
    const r = maybeResetWorkspace(gateInput({ recordedBranch: "main", branchPrefix: "" }), deps);
    expect(r.reset).toBe(false);
    if (!r.reset) expect(r.reason).toMatch(/no Sparra branch prefix/);
    expect(calls).toEqual({ restore: 0, clean: 0 });
  });
});

describe("maybeResetWorkspace — real git in a TEMP repo (never the dev tree)", () => {
  function tmpRepo(branch = "sparra/run"): { ws: string; outside: string; parent: string } {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-reset-"));
    const ws = path.join(parent, "repo");
    const outside = path.join(parent, "outside.txt");
    fs.mkdirSync(ws);
    fs.writeFileSync(outside, "outside-untouched");
    g(ws, ["init", "-q"]);
    g(ws, ["config", "user.email", "t@t"]);
    g(ws, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(ws, "tracked.txt"), "original\n");
    fs.writeFileSync(path.join(ws, ".gitignore"), "scratch.log\n");
    g(ws, ["add", "-A"]);
    g(ws, ["commit", "-q", "-m", "item-start"]);
    g(ws, ["checkout", "-q", "-B", branch]); // -B: "main" may already be the init default
    return { ws, outside, parent };
  }
  const dirty = (ws: string) => {
    fs.writeFileSync(path.join(ws, "tracked.txt"), "MUTATED by failed attempt\n");
    fs.writeFileSync(path.join(ws, "untracked.txt"), "new non-ignored file");
    fs.writeFileSync(path.join(ws, "scratch.log"), "gitignored scratch must survive");
  };

  it("resets tracked+untracked, keeps gitignored scratch (no -x), touches nothing outside", () => {
    const { ws, outside, parent } = tmpRepo();
    dirty(ws);
    const r = maybeResetWorkspace(
      gateInput({ workspaceDir: ws, persistedWorkspaceDir: ws, recordedBranch: "sparra/run" }),
      realResetDeps()
    );
    expect(r.reset).toBe(true);
    expect(fs.readFileSync(path.join(ws, "tracked.txt"), "utf8")).toBe("original\n"); // reverted
    expect(fs.existsSync(path.join(ws, "untracked.txt"))).toBe(false); // cleaned
    expect(fs.readFileSync(path.join(ws, "scratch.log"), "utf8")).toBe("gitignored scratch must survive"); // no -x
    expect(fs.readFileSync(outside, "utf8")).toBe("outside-untouched"); // scoped to the workspace dir
    fs.rmSync(parent, { recursive: true, force: true });
  });

  it("(e) real non-git dir refuses (dirt untouched)", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-nogit-"));
    fs.writeFileSync(path.join(parent, "f.txt"), "x");
    const r = maybeResetWorkspace(gateInput({ workspaceDir: parent, persistedWorkspaceDir: parent }), realResetDeps());
    expect(r.reset).toBe(false);
    expect(fs.readFileSync(path.join(parent, "f.txt"), "utf8")).toBe("x");
    fs.rmSync(parent, { recursive: true, force: true });
  });

  it("(f) real detached HEAD refuses; dirty files survive", () => {
    const { ws, parent } = tmpRepo();
    g(ws, ["checkout", "-q", "--detach"]);
    dirty(ws);
    const r = maybeResetWorkspace(
      gateInput({ workspaceDir: ws, persistedWorkspaceDir: ws, recordedBranch: "sparra/run" }),
      realResetDeps()
    );
    expect(r.reset).toBe(false);
    expect(fs.existsSync(path.join(ws, "untracked.txt"))).toBe(true); // nothing was reset
    fs.rmSync(parent, { recursive: true, force: true });
  });

  it("real ownership refusal: repo ON \"main\" with recordedBranch \"main\" (prefix \"sparra/\") does NOT reset; dirty files untouched", () => {
    // The round-1 live probe, now closed: a matching-but-user-owned branch must refuse.
    const { ws, parent } = tmpRepo("main");
    dirty(ws);
    const r = maybeResetWorkspace(
      gateInput({ workspaceDir: ws, persistedWorkspaceDir: ws, recordedBranch: "main" }),
      realResetDeps()
    );
    expect(r.reset).toBe(false);
    if (!r.reset) expect(r.reason).toMatch(/not Sparra-owned/);
    expect(fs.readFileSync(path.join(ws, "tracked.txt"), "utf8")).toContain("MUTATED"); // untouched
    expect(fs.existsSync(path.join(ws, "untracked.txt"))).toBe(true); // not cleaned
    fs.rmSync(parent, { recursive: true, force: true });
  });

  it("(g) real branch mismatch (stale recorded branch) refuses; dirty files survive", () => {
    const { ws, parent } = tmpRepo();
    dirty(ws);
    const r = maybeResetWorkspace(
      gateInput({ workspaceDir: ws, persistedWorkspaceDir: ws, recordedBranch: "sparra/DIFFERENT" }),
      realResetDeps()
    );
    expect(r.reset).toBe(false);
    expect(fs.readFileSync(path.join(ws, "tracked.txt"), "utf8")).toContain("MUTATED");
    fs.rmSync(parent, { recursive: true, force: true });
  });
  // Each case spawns several real `git` processes; under full-suite parallel load (esp. in a
  // provisioned eval worktree) that can exceed Vitest's 5s default and flake, though it passes in
  // isolation. Give the real-git suite headroom — the assertions are unchanged.
}, 20000);

describe("attempt ledger (build/attempts.ts)", () => {
  it("caps oversized approach/failure with the truncation marker", () => {
    const item = makeItem();
    recordAttempt(item, { round: 3, approach: "A".repeat(2000), failure: "B".repeat(2000) });
    const e = item.attempts![0]!;
    expect(e.round).toBe(3);
    expect(e.approach.length).toBe(APPROACH_CAP + TRUNCATION_MARKER.length);
    expect(e.approach.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(e.failure.length).toBe(FAILURE_CAP + TRUNCATION_MARKER.length);
    expect(e.failure.endsWith(TRUNCATION_MARKER)).toBe(true);
  });
  it("renders a bounded PRIOR ATTEMPTS section (last N only); empty ledger renders ''", () => {
    expect(renderPriorAttempts(undefined)).toBe("");
    expect(renderPriorAttempts([])).toBe("");
    const item = makeItem();
    for (let i = 1; i <= 8; i++) recordAttempt(item, { round: i, approach: `approach-${i}`, failure: `fail-${i}` });
    const s = renderPriorAttempts(item.attempts);
    expect(s).toContain("PRIOR ATTEMPTS — do not repeat these approaches");
    expect(s).not.toContain("approach-3"); // bounded: only the last 5 entries
    expect(s).toContain("approach-4");
    expect(s).toContain("approach-8");
  });
});
