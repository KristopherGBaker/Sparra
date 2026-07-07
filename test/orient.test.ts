import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Paths } from "../src/paths.ts";
import { StateStore } from "../src/state.ts";
import { defaultConfig } from "../src/config.ts";
import { seedPrompts } from "../src/prompts.ts";
import { cmdOrient } from "../src/phases/orient.ts";
import type { Ctx } from "../src/context.ts";
import type { RunResult, RunSessionParams } from "../src/sdk/session.ts";

async function ctxFor(): Promise<{ ctx: Ctx; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-orient-"));
  const paths = new Paths(dir);
  await paths.ensureScaffold();
  await seedPrompts(paths);
  const store = StateStore.create(paths, "existing");
  store.data.autoSupported = false; // skip the live auto-probe
  return { ctx: { root: dir, paths, config: defaultConfig(), store }, dir };
}

function okResult(): RunResult {
  return {
    ok: true,
    subtype: "success",
    resultText: "mapped",
    sessionId: "orient-session",
    costUsd: 0,
    tokens: 0,
    numTurns: 1,
    hitMaxTurns: false,
    hitBudget: false,
    errors: [],
    tracePath: "",
  };
}

/** Drive the captured request's single PreToolUse decider and return its decision. */
async function decide(p: RunSessionParams, tool_name: string, tool_input: unknown): Promise<string> {
  const cb = (p as any).hooks.PreToolUse![0]!.hooks[0]!;
  const out: any = await cb({ hook_event_name: "PreToolUse", tool_name, tool_input } as any, "id", {} as any);
  return out?.hookSpecificOutput?.permissionDecision ?? "defer";
}

describe("cmdOrient — the orienter must be able to WRITE CODEBASE_MAP.md", () => {
  it("wires the Write/Edit tools + a single-file writer guard scoped to CODEBASE_MAP.md", async () => {
    const { ctx } = await ctxFor();
    let captured: RunSessionParams | undefined;
    const runSessionFn = async (p: RunSessionParams): Promise<RunResult> => {
      captured = p;
      fs.writeFileSync(ctx.paths.codebaseMap, "# map"); // simulate the orienter writing the file
      return okResult();
    };

    await cmdOrient(ctx, { runSessionFn });

    const p = captured!;
    // Regression: a read-only guard (the old wiring) has NO write channel — this asserts the fix.
    expect(p.tools).toContain("Write");
    expect(p.tools).toContain("Edit");

    // The one allowed file is writable; every other write and any Bash mutation stays blocked.
    expect(await decide(p, "Write", { file_path: ctx.paths.codebaseMap })).not.toBe("deny");
    expect(await decide(p, "Write", { file_path: path.join(ctx.root, "src/app.ts") })).toBe("deny");
    // Bash redirects/mutations are blocked (the orienter must use Write, not a shell redirect) …
    expect(await decide(p, "Bash", { command: `echo hi > ${ctx.paths.codebaseMap}` })).toBe("deny");
    // … but read-only Bash for mapping the repo is fine.
    expect(await decide(p, "Bash", { command: "cat package.json" })).not.toBe("deny");
  });

  it("transitions to plan once CODEBASE_MAP.md is written", async () => {
    const { ctx } = await ctxFor();
    const runSessionFn = async (p: RunSessionParams): Promise<RunResult> => {
      fs.writeFileSync(ctx.paths.codebaseMap, "# map");
      return okResult();
    };

    await cmdOrient(ctx, { runSessionFn });

    expect(fs.existsSync(ctx.paths.codebaseMap)).toBe(true);
    expect(ctx.store.data.phase).toBe("plan");
  });

  it("does NOT transition when the orienter fails to write the map (graceful warn path)", async () => {
    const { ctx } = await ctxFor();
    const runSessionFn = async (): Promise<RunResult> => okResult(); // writes nothing

    await cmdOrient(ctx, { runSessionFn });

    expect(fs.existsSync(ctx.paths.codebaseMap)).toBe(false);
    expect(ctx.store.data.phase).not.toBe("plan");
  });
});
