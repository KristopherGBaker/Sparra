import { describe, it, expect } from "vitest";
import { scopedWriterGuard, evaluatorGuard, readOnlyGuard, singleFileGuard } from "../src/sdk/guard.ts";
import { hasReportTurnWarningHook } from "../src/sdk/turnWarning.ts";
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

describe("scopedWriterGuard — in-place verify opt-in (H7)", () => {
  it("auto-approves a verify command in-place (no branch) WHEN verifyInPlace is set", async () => {
    const g = scopedWriterGuard(ctxWith(undefined), ["/work"], { verify: true, verifyInPlace: true });
    expect(await decide(g, "Bash", { command: "npm test" })).toBe("allow");
  });

  it("verifyInPlace WITHOUT verify does NOT auto-approve (verify must also be requested)", async () => {
    const g = scopedWriterGuard(ctxWith(undefined), ["/work"], { verifyInPlace: true });
    expect(await decide(g, "Bash", { command: "npm test" })).toBe("defer");
  });

  it("the opt-in still routes through allowVerifyBash's disqualifiers (no new auto-approve surface)", async () => {
    const g = scopedWriterGuard(ctxWith(undefined), ["/work"], { verify: true, verifyInPlace: true });
    expect(await decide(g, "Bash", { command: "npm test && rm -rf x" })).toBe("defer");
    expect(await decide(g, "Bash", { command: "rm -rf /" })).not.toBe("allow");
  });

  it("on a branch the opt-in is a no-op — verify already enabled regardless", async () => {
    const g = scopedWriterGuard(ctxWith("sparra/x"), ["/work"], { verify: true, verifyInPlace: false });
    expect(await decide(g, "Bash", { command: "npm test" })).toBe("allow");
  });
});

describe("scopedWriterGuard — report turns-remaining warning (U-T)", () => {
  // Assertion 5: the warning is a PostToolUse hook MERGED into the writer set — the pre-existing
  // scope/verify PreToolUse hooks still function AND the warning hook is present.
  it("MERGES the warning without displacing the scope/verify writer hooks", async () => {
    const g = scopedWriterGuard(ctxWith("sparra/x"), ["/work"], {
      format: true,
      verify: true,
      reportWarning: { maxTurns: 60 },
    });
    // Pre-existing scope enforcement still works (out-of-root write denied; verify auto-approved).
    expect(await decide(g, "Write", { file_path: "/etc/passwd", content: "x" })).toBe("deny");
    expect(await decide(g, "Bash", { command: "npm test" })).toBe("allow");
    // …and the new warning hook is present in the assembled set.
    expect(hasReportTurnWarningHook(g.hooks)).toBe(true);
    // …exposing the onAssistantText counter seam the request must spread.
    expect(typeof g.onAssistantText).toBe("function");
  });

  // Assertion 6 (negative role-scope): only a writer that OPTS IN gets the warning. Every other
  // guard builder — including a writer WITHOUT reportWarning (reflect/prototype) and the read-only /
  // evaluator / single-file roles (contract-generator, contract-evaluator, evaluator, decomposer,
  // reviewer, planner) — does NOT carry the "emit completion report" warning.
  it("a writer WITHOUT reportWarning does NOT carry the warning (reflect/prototype)", () => {
    const g = scopedWriterGuard(ctxWith("sparra/x"), ["/work"], { format: true, verify: true });
    expect(hasReportTurnWarningHook(g.hooks)).toBe(false);
    expect(g.onAssistantText).toBeUndefined();
  });

  it("read-only / evaluator / single-file guards never carry the warning", () => {
    for (const g of [readOnlyGuard(ctxWith(undefined)), evaluatorGuard(ctxWith(undefined)), singleFileGuard(ctxWith(undefined), "/work/PLAN.md")]) {
      expect(hasReportTurnWarningHook(g.hooks)).toBe(false);
    }
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
