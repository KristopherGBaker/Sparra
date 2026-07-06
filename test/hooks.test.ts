import { describe, it, expect } from "vitest";
import { scopedWriterHooks, singleFileHooks, readOnlyHooks, evaluatorHooks, makeGuardHook } from "../src/sdk/hooks.ts";
import type { HookConfig } from "../src/sdk/hooks.ts";

/** Invoke a HookConfig's single PreToolUse decider with a tool call, return its decision. */
async function decide(cfg: HookConfig, tool_name: string, tool_input: unknown) {
  const cb = cfg.PreToolUse![0]!.hooks[0]!;
  const out: any = await cb({ hook_event_name: "PreToolUse", tool_name, tool_input } as any, "tool_use_id", {} as any);
  return out?.hookSpecificOutput?.permissionDecision ?? "defer";
}

/** Like {@link decide} but returns the full {decision, reason} so a deny message can be asserted. */
async function decideFull(cfg: HookConfig, tool_name: string, tool_input: unknown) {
  const cb = cfg.PreToolUse![0]!.hooks[0]!;
  const out: any = await cb({ hook_event_name: "PreToolUse", tool_name, tool_input } as any, "tool_use_id", {} as any);
  return {
    decision: out?.hookSpecificOutput?.permissionDecision ?? "defer",
    reason: out?.hookSpecificOutput?.permissionDecisionReason ?? "",
  };
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

describe("scopedWriterHooks — always-readable workspace (Item B)", () => {
  it("AUTO-APPROVES an in-scope Read/Glob/Grep so a writer never starves on denied reads", async () => {
    const cfg = scopedWriterHooks(ROOTS, [], [], { readScopes: ROOTS });
    expect(await decide(cfg, "Read", { file_path: "/work/src/a.ts" })).toBe("allow");
    expect(await decide(cfg, "Grep", { path: "/work/src", pattern: "foo" })).toBe("allow");
    expect(await decide(cfg, "Read", { file_path: "src/a.ts" })).toBe("allow"); // relative → resolved in scope
  });

  it("DEFERS an out-of-scope or pathless read (never broadens beyond the scope)", async () => {
    const cfg = scopedWriterHooks(ROOTS, [], [], { readScopes: ROOTS });
    expect(await decide(cfg, "Read", { file_path: "/etc/passwd" })).toBe("defer");
    expect(await decide(cfg, "Grep", { pattern: "secret" })).toBe("defer"); // pathless → defer, don't auto-grant
  });

  it("DENY wins over the read allow: an extraDeny (holdout) read loses even inside the read scope", async () => {
    const denyHoldout = (t: string, i: any) =>
      (t === "Read" || t === "Grep") && String(i?.file_path ?? i?.path ?? "").includes("HOLDOUT") ? "holdout is evaluator-only" : null;
    const cfg = scopedWriterHooks(ROOTS, [], [], { readScopes: ROOTS, extraDeny: [denyHoldout] });
    // A holdout file physically inside the workspace would be in readScopes — deny must still win.
    expect(await decide(cfg, "Read", { file_path: "/work/.sparra/HOLDOUT.md" })).toBe("deny");
    expect(await decide(cfg, "Read", { file_path: "/work/src/a.ts" })).toBe("allow"); // ordinary reads still granted
  });
});

describe("dangerouslyDisableSandbox deny — every autonomous Claude hook constructor (U3 Part B)", () => {
  // Each of the four constructors, exercised through its real deny path.
  const constructors: Array<[string, HookConfig]> = [
    ["scopedWriterHooks", scopedWriterHooks(ROOTS, ["git push"], VERIFY)],
    ["singleFileHooks", singleFileHooks("/work/PLAN.md", ["git push"])],
    ["readOnlyHooks", readOnlyHooks(["git push"])],
    ["evaluatorHooks", evaluatorHooks(["git push"])],
  ];

  for (const [name, cfg] of constructors) {
    it(`${name}: DENIES a Bash call carrying dangerouslyDisableSandbox: true, naming the flag`, async () => {
      const { decision, reason } = await decideFull(cfg, "Bash", { command: "git -C /x status", dangerouslyDisableSandbox: true });
      expect(decision).toBe("deny");
      expect(reason).toMatch(/dangerouslyDisableSandbox/);
    });

    it(`${name}: is unaffected by this decider when the flag is absent/false (additive)`, async () => {
      // A benign in-scope read is not denied by the flag decider when the flag is absent or false.
      expect(await decide(cfg, "Read", { file_path: "/work/README.md", dangerouslyDisableSandbox: false })).not.toBe("deny");
      // A plainly-dangerous command still denies for its OWN reason (not the flag) — deny not weakened.
      const { reason } = await decideFull(cfg, "Bash", { command: "git push origin main" });
      expect(reason).not.toMatch(/dangerouslyDisableSandbox/);
    });
  }
});
