import { describe, it, expect } from "vitest";
import { exerciseScratchEnabled } from "../src/build/exerciseScratch.ts";

describe("exerciseScratchEnabled — truth table", () => {
  it("in-place (judge, ws-write, no branch, no worktree) ⇒ false", () => {
    expect(exerciseScratchEnabled({ judge: true, sandbox: "workspace-write", hasBranch: false, isWorktree: false })).toBe(
      false
    );
  });

  it("worktree, no branch ⇒ true (the new capability)", () => {
    expect(exerciseScratchEnabled({ judge: true, sandbox: "workspace-write", hasBranch: false, isWorktree: true })).toBe(
      true
    );
  });

  it("build-loop (branch, no worktree) ⇒ true", () => {
    expect(exerciseScratchEnabled({ judge: true, sandbox: "workspace-write", hasBranch: true, isWorktree: false })).toBe(
      true
    );
  });

  it("non-judge + worktree ⇒ false", () => {
    expect(exerciseScratchEnabled({ judge: false, sandbox: "workspace-write", hasBranch: true, isWorktree: true })).toBe(
      false
    );
  });

  it("sandbox != workspace-write ⇒ false (even with branch + worktree)", () => {
    expect(exerciseScratchEnabled({ judge: true, sandbox: "read-only", hasBranch: true, isWorktree: true })).toBe(false);
  });

  it("computes isWorktree LAZILY — the thunk is NOT called once the cheaper guards fail", () => {
    let called = 0;
    const thunk = () => {
      called++;
      return true;
    };
    // Non-judge short-circuits before the worktree probe.
    expect(exerciseScratchEnabled({ judge: false, sandbox: "workspace-write", hasBranch: false, isWorktree: thunk })).toBe(
      false
    );
    // hasBranch resolves true before the worktree probe.
    expect(exerciseScratchEnabled({ judge: true, sandbox: "workspace-write", hasBranch: true, isWorktree: thunk })).toBe(
      true
    );
    expect(called).toBe(0);
    // Only when judge+ws-write+no-branch is the thunk consulted.
    expect(exerciseScratchEnabled({ judge: true, sandbox: "workspace-write", hasBranch: false, isWorktree: thunk })).toBe(
      true
    );
    expect(called).toBe(1);
  });
});
