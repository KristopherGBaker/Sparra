import { describe, it, expect } from "vitest";
import { scopedWriterHooks, makeGuardHook } from "../src/sdk/hooks.ts";

/** Invoke a HookConfig's single PreToolUse decider with a tool call, return its decision. */
async function decide(cfg: ReturnType<typeof scopedWriterHooks>, tool_name: string, tool_input: unknown) {
  const cb = cfg.PreToolUse![0]!.hooks[0]!;
  const out: any = await cb({ hook_event_name: "PreToolUse", tool_name, tool_input } as any, "tool_use_id", {} as any);
  return out?.hookSpecificOutput?.permissionDecision ?? "defer";
}

const ROOTS = ["/work"];
const VERIFY = ["npm test", "tsc"];

describe("scopedWriterHooks — generator self-verify auto-approval", () => {
  it("AUTO-APPROVES a verify command when verifyCommands is provided", async () => {
    const cfg = scopedWriterHooks(ROOTS, ["git push"], VERIFY);
    expect(await decide(cfg, "Bash", { command: "npm test" })).toBe("allow");
    expect(await decide(cfg, "Bash", { command: "tsc --noEmit" })).toBe("allow");
  });

  it("DEFERS a verify command when verifyCommands is empty (the worktree gate is off)", async () => {
    const cfg = scopedWriterHooks(ROOTS, ["git push"]); // no verifyCommands → no auto-approval
    expect(await decide(cfg, "Bash", { command: "npm test" })).toBe("defer");
  });

  it("still DENIES dangerous Bash even with verify enabled (deny wins over allow)", async () => {
    const cfg = scopedWriterHooks(ROOTS, ["git push"], VERIFY);
    expect(await decide(cfg, "Bash", { command: "git push origin main" })).toBe("deny");
  });

  it("DEFERS non-verify Bash (unchanged behavior — needs the permission mode)", async () => {
    const cfg = scopedWriterHooks(ROOTS, ["git push"], VERIFY);
    expect(await decide(cfg, "Bash", { command: "node scratch.js" })).toBe("defer");
  });

  it("still DENIES a write outside the work roots", async () => {
    const cfg = scopedWriterHooks(ROOTS, [], VERIFY);
    expect(await decide(cfg, "Write", { file_path: "/etc/passwd" })).toBe("deny");
    expect(await decide(cfg, "Write", { file_path: "/work/src/a.ts" })).toBe("defer"); // in-scope → defer to mode
  });

  it("makeGuardHook with no allow-deciders behaves exactly like a deny-only hook", async () => {
    const cfg = makeGuardHook([(t) => (t === "Bash" ? "no bash" : null)], []);
    expect(await decide(cfg, "Bash", { command: "npm test" })).toBe("deny");
    expect(await decide(cfg, "Read", { file_path: "/x" })).toBe("defer");
  });
});
