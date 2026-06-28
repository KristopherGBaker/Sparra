import { describe, it, expect } from "vitest";
import { exerciseScratchEnabled } from "../src/build/exerciseScratch.ts";

describe("exerciseScratchEnabled — truth table", () => {
  it("in-place (evaluator, ws-write, no branch, no worktree) ⇒ false", () => {
    expect(exerciseScratchEnabled({ evaluator: true, sandbox: "workspace-write", hasBranch: false, isWorktree: false })).toBe(
      false
    );
  });

  it("worktree, no branch ⇒ true (the new capability)", () => {
    expect(exerciseScratchEnabled({ evaluator: true, sandbox: "workspace-write", hasBranch: false, isWorktree: true })).toBe(
      true
    );
  });

  it("build-loop (branch, no worktree) ⇒ true", () => {
    expect(exerciseScratchEnabled({ evaluator: true, sandbox: "workspace-write", hasBranch: true, isWorktree: false })).toBe(
      true
    );
  });

  it("non-evaluator + worktree ⇒ false", () => {
    expect(exerciseScratchEnabled({ evaluator: false, sandbox: "workspace-write", hasBranch: true, isWorktree: true })).toBe(
      false
    );
  });

  it("sandbox != workspace-write ⇒ false (even with branch + worktree)", () => {
    expect(exerciseScratchEnabled({ evaluator: true, sandbox: "read-only", hasBranch: true, isWorktree: true })).toBe(false);
  });

  it("computes isWorktree LAZILY — the thunk is NOT called once the cheaper guards fail", () => {
    let called = 0;
    const thunk = () => {
      called++;
      return true;
    };
    // Non-evaluator short-circuits before the worktree probe.
    expect(exerciseScratchEnabled({ evaluator: false, sandbox: "workspace-write", hasBranch: false, isWorktree: thunk })).toBe(
      false
    );
    // hasBranch resolves true before the worktree probe.
    expect(exerciseScratchEnabled({ evaluator: true, sandbox: "workspace-write", hasBranch: true, isWorktree: thunk })).toBe(
      true
    );
    expect(called).toBe(0);
    // Only when evaluator+ws-write+no-branch is the thunk consulted.
    expect(exerciseScratchEnabled({ evaluator: true, sandbox: "workspace-write", hasBranch: false, isWorktree: thunk })).toBe(
      true
    );
    expect(called).toBe(1);
  });
});
