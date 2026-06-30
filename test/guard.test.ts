import { describe, it, expect } from "vitest";
import { scopedWriterGuard, evaluatorGuard } from "../src/sdk/guard.ts";
import { defaultConfig } from "../src/config.ts";
import type { Ctx } from "../src/context.ts";

/** Minimal ctx for the guard (no filesystem needed when `format` is off). */
function ctxWith(branch: string | undefined, verifyCommands = defaultConfig().build.verifyCommands): Ctx {
  const config = defaultConfig();
  config.build.verifyCommands = verifyCommands;
  return {
    root: "/work",
    paths: {} as any,
    config,
    store: { data: { build: branch ? { branch } : {}, autoSupported: false } } as any,
  } as Ctx;
}

async function decide(guard: ReturnType<typeof scopedWriterGuard>, tool_name: string, tool_input: unknown) {
  const cb = guard.hooks.PreToolUse![0]!.hooks[0]!;
  const out: any = await cb({ hook_event_name: "PreToolUse", tool_name, tool_input } as any, "id", {} as any);
  return out?.hookSpecificOutput?.permissionDecision ?? "defer";
}

describe("scopedWriterGuard — worktree-gated generator self-verify", () => {
  it("auto-approves a verify command WHEN on a branch boundary and verify:true", async () => {
    const g = scopedWriterGuard(ctxWith("sparra/x"), ["/work"], { verify: true });
    expect(await decide(g, "Bash", { command: "npm test" })).toBe("allow");
  });

  it("does NOT auto-approve with NO branch (in-place stays locked), even with verify:true", async () => {
    const g = scopedWriterGuard(ctxWith(undefined), ["/work"], { verify: true });
    expect(await decide(g, "Bash", { command: "npm test" })).toBe("defer");
  });

  it("does NOT auto-approve when verify is not requested", async () => {
    const g = scopedWriterGuard(ctxWith("sparra/x"), ["/work"], {});
    expect(await decide(g, "Bash", { command: "npm test" })).toBe("defer");
  });

  it("does NOT auto-approve when verifyCommands is empty even on a branch", async () => {
    const g = scopedWriterGuard(ctxWith("sparra/x", []), ["/work"], { verify: true });
    expect(await decide(g, "Bash", { command: "npm test" })).toBe("defer");
  });
});

describe("evaluatorGuard — denies tree-mutating git (H1)", () => {
  // The five tree-mutating git commands the read-only evaluator must never run (it would clobber
  // the worktree it grades / trip the source-integrity guard). Behavioral: target the guard result.
  const MUTATING = ["git clean -xfd", "git checkout -- .", "git reset --hard", "git restore .", "git stash"];
  it.each(MUTATING)("DENIES %s", async (command) => {
    const g = evaluatorGuard(ctxWith(undefined));
    expect(await decide(g, "Bash", { command })).toBe("deny");
  });

  it("ALLOWS (defers) non-mutating git the evaluator needs to inspect the artifact", async () => {
    const g = evaluatorGuard(ctxWith(undefined));
    for (const command of ["git status", "git diff", "git ls-files", "git log --oneline"]) {
      expect(await decide(g, "Bash", { command })).toBe("defer");
    }
  });

  it("does NOT newly deny tree-mutating git on the writer generator (scope is the evaluator)", async () => {
    // The generator legitimately uses git; the new deny must not leak onto it.
    const g = scopedWriterGuard(ctxWith("sparra/x"), ["/work"], {});
    for (const command of MUTATING) {
      expect(await decide(g, "Bash", { command })).not.toBe("deny");
    }
  });
});
