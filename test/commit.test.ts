import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { commitItem, templateCommitMessage, type CommitGit } from "../src/build/commit.ts";
import { Paths } from "../src/paths.ts";
import { StateStore } from "../src/state.ts";
import { defaultConfig } from "../src/config.ts";
import type { Ctx } from "../src/context.ts";
import type { WorkItem } from "../src/build/types.ts";
import type { RunResult, RunSessionParams } from "../src/sdk/session.ts";

async function makeCtx(): Promise<{ ctx: Ctx; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-commit-"));
  const paths = new Paths(dir);
  await paths.ensureScaffold();
  const store = StateStore.create(paths, "greenfield");
  return { ctx: { root: dir, paths, config: defaultConfig(), store }, dir };
}

const item: WorkItem = { id: "item-001", title: "Add parser", summary: "parse nested groups", dependsOn: [], rationale: "" };

/** A fake git seam recording every commit (commitPaths only — no `git add -A` anywhere). */
function fakeGit(dir: string, changed: string[]) {
  const commits: { files: string[]; message: string }[] = [];
  const git: CommitGit = {
    changedFiles: () => changed.map((f) => path.join(dir, f)),
    workingDiff: () => "DIFF",
    commitPaths: (_ws, files, message) => {
      commits.push({ files, message });
      return { ok: true, out: "" };
    },
  };
  return { git, commits };
}

function planRun(plan: unknown): (p: RunSessionParams) => Promise<RunResult> {
  return async () => ({
    ok: true, subtype: "success", resultText: "```json\n" + JSON.stringify(plan) + "\n```",
    sessionId: "c", costUsd: 0, tokens: 5, numTurns: 1, hitMaxTurns: false, hitBudget: false, errors: [], tracePath: "",
  });
}
const textRun = (text: string): ((p: RunSessionParams) => Promise<RunResult>) => async () => ({
  ok: true, subtype: "success", resultText: text, sessionId: "c", costUsd: 0, tokens: 5,
  numTurns: 1, hitMaxTurns: false, hitBudget: false, errors: [], tracePath: "",
});

const common = (dir: string) => ({ item, deviations: [], runId: "build-X", workspaceDir: dir, traceDir: dir, traceSeq: 1 });

describe("commitItem — agent mode", () => {
  it("executes a multi-commit plan, one commit per group, with the Sparra-Item trailer", async () => {
    const { ctx, dir } = await makeCtx();
    const g = fakeGit(dir, ["src/parse.ts", "test/parse.test.ts", "README.md"]);
    const plan = { commits: [
      { message: "feat(parser): handle nested groups", files: ["src/parse.ts", "test/parse.test.ts"] },
      { message: "docs: note the parser", files: ["README.md"] },
    ] };
    const r = await commitItem(ctx, { ...common(dir), git: g.git, runSessionFn: planRun(plan) });
    expect(r.commits).toBe(2);
    expect(g.commits.map((c) => c.files)).toEqual([["src/parse.ts", "test/parse.test.ts"], ["README.md"]]);
    expect(g.commits[0]!.message).toContain("feat(parser): handle nested groups");
    expect(g.commits.every((c) => c.message.includes("Sparra-Item: item-001"))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("sweeps files the plan missed into a final template commit (loses nothing)", async () => {
    const { ctx, dir } = await makeCtx();
    const g = fakeGit(dir, ["src/a.ts", "src/b.ts"]);
    const plan = { commits: [{ message: "feat: a", files: ["src/a.ts"] }] }; // b.ts omitted
    const r = await commitItem(ctx, { ...common(dir), git: g.git, runSessionFn: planRun(plan) });
    expect(r.commits).toBe(2);
    expect(g.commits[1]!.files).toEqual(["src/b.ts"]); // swept
    expect(g.commits[1]!.message).toMatch(/^feat: add parser/); // template
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("ignores hallucinated paths not in the diff", async () => {
    const { ctx, dir } = await makeCtx();
    const g = fakeGit(dir, ["src/a.ts"]);
    const plan = { commits: [{ message: "feat: a", files: ["src/a.ts", "ghost.ts"] }] };
    await commitItem(ctx, { ...common(dir), git: g.git, runSessionFn: planRun(plan) });
    expect(g.commits).toHaveLength(1);
    expect(g.commits[0]!.files).toEqual(["src/a.ts"]); // ghost.ts dropped
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("never commits the holdout, even if it shows up as a changed file", async () => {
    const { ctx, dir } = await makeCtx();
    const holdoutRel = path.relative(dir, ctx.paths.holdout);
    const g = fakeGit(dir, ["src/a.ts", holdoutRel]);
    const plan = { commits: [{ message: "feat: a", files: ["src/a.ts", holdoutRel] }] };
    await commitItem(ctx, { ...common(dir), git: g.git, runSessionFn: planRun(plan) });
    const allFiles = g.commits.flatMap((c) => c.files);
    expect(allFiles).not.toContain(holdoutRel);
    expect(allFiles).toContain("src/a.ts");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("falls back to a single template commit when the plan is unparseable", async () => {
    const { ctx, dir } = await makeCtx();
    const g = fakeGit(dir, ["src/a.ts"]);
    const r = await commitItem(ctx, { ...common(dir), git: g.git, runSessionFn: textRun("sorry, no json") });
    expect(r.commits).toBe(1);
    expect(g.commits[0]!.files).toEqual(["src/a.ts"]);
    expect(g.commits[0]!.message).toContain("Sparra-Item: item-001");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("does nothing when there are no changes", async () => {
    const { ctx, dir } = await makeCtx();
    const g = fakeGit(dir, []);
    let ran = false;
    const r = await commitItem(ctx, { ...common(dir), git: g.git, runSessionFn: async () => { ran = true; return textRun("")({} as RunSessionParams); } });
    expect(r).toEqual({ ok: false, commits: 0 });
    expect(ran).toBe(false); // no diff → committer never invoked
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("commitItem — template mode", () => {
  it("commits once from item metadata and never calls the model", async () => {
    const { ctx, dir } = await makeCtx();
    ctx.config.git.agentCommits = "template";
    const g = fakeGit(dir, ["src/a.ts", "src/b.ts"]);
    let ran = false;
    const r = await commitItem(ctx, { ...common(dir), git: g.git, runSessionFn: async () => { ran = true; return textRun("")({} as RunSessionParams); } });
    expect(ran).toBe(false);
    expect(r.commits).toBe(1);
    expect(g.commits[0]!.files).toEqual(["src/a.ts", "src/b.ts"]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("templateCommitMessage", () => {
  it("is a conventional commit with the tracking trailer", () => {
    const msg = templateCommitMessage(item, [], "build-X");
    expect(msg).toMatch(/^feat: add parser/);
    expect(msg).toContain("Sparra-Item: item-001 · build build-X");
  });
});
