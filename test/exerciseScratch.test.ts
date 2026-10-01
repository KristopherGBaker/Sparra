import { describe, it, expect } from "vitest";
import {
  appleSandboxWarning,
  exerciseSandboxMode,
  exerciseScratchEnabled,
  fullAccessRefusalWarning,
} from "../src/build/exerciseScratch.ts";

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

describe("exerciseSandboxMode — the danger-full-access carve-out", () => {
  const judgeOn = { judge: true, hasBranch: true, isWorktree: false } as const;

  it("grants the REQUESTED writable mode on an isolated checkout (branch OR worktree)", () => {
    expect(exerciseSandboxMode({ ...judgeOn, sandbox: "workspace-write" })).toBe("workspace-write");
    expect(exerciseSandboxMode({ ...judgeOn, sandbox: "danger-full-access" })).toBe("danger-full-access");
    // The worktree branch of the gate grants full access too (a standalone `sparra eval` on a worktree).
    expect(
      exerciseSandboxMode({ judge: true, sandbox: "danger-full-access", hasBranch: false, isWorktree: true })
    ).toBe("danger-full-access");
  });

  it("GATES full access on the isolated checkout — no branch, no worktree ⇒ read-only, never granted", () => {
    expect(
      exerciseSandboxMode({ judge: true, sandbox: "danger-full-access", hasBranch: false, isWorktree: false })
    ).toBe("read-only");
  });

  it("never grants full access to a NON-judge role, even on a branch + worktree", () => {
    expect(
      exerciseSandboxMode({ judge: false, sandbox: "danger-full-access", hasBranch: true, isWorktree: true })
    ).toBe("read-only");
  });

  it("an unrecognized sandbox string is read-only (no accidental relaxation)", () => {
    expect(exerciseSandboxMode({ ...judgeOn, sandbox: "read-only" })).toBe("read-only");
    expect(exerciseSandboxMode({ ...judgeOn, sandbox: "workspace-read" })).toBe("read-only");
  });

  it("scratch is enabled for EVERY relaxed mode (both writable modes write + need the guard armed)", () => {
    expect(exerciseScratchEnabled({ ...judgeOn, sandbox: "danger-full-access" })).toBe(true);
    expect(exerciseScratchEnabled({ ...judgeOn, sandbox: "workspace-write" })).toBe(true);
    expect(exerciseScratchEnabled({ ...judgeOn, sandbox: "read-only" })).toBe(false);
  });

  it("keeps the worktree probe LAZY on the full-access path too", () => {
    let called = 0;
    const thunk = () => {
      called++;
      return true;
    };
    expect(exerciseSandboxMode({ judge: false, sandbox: "danger-full-access", hasBranch: false, isWorktree: thunk })).toBe(
      "read-only"
    );
    expect(exerciseSandboxMode({ judge: true, sandbox: "danger-full-access", hasBranch: true, isWorktree: thunk })).toBe(
      "danger-full-access"
    );
    expect(called).toBe(0);
    expect(exerciseSandboxMode({ judge: true, sandbox: "danger-full-access", hasBranch: false, isWorktree: thunk })).toBe(
      "danger-full-access"
    );
    expect(called).toBe(1);
  });
});

describe("fullAccessRefusalWarning", () => {
  it("warns LOUDLY only when full access was asked for and DENIED", () => {
    const w = fullAccessRefusalWarning({ requested: "danger-full-access", mode: "read-only", roleLabel: "evaluator-1" });
    expect(w).toContain("Refusing 'danger-full-access'");
    expect(w).toContain("evaluator-1");
    expect(w).toContain("UN-RUN");
  });

  it("is silent when full access was GRANTED", () => {
    expect(
      fullAccessRefusalWarning({ requested: "danger-full-access", mode: "danger-full-access", roleLabel: "r" })
    ).toBeUndefined();
  });

  it("is silent on the everyday workspace-write fallback (in-place runs must not spam)", () => {
    expect(fullAccessRefusalWarning({ requested: "workspace-write", mode: "read-only", roleLabel: "r" })).toBeUndefined();
    expect(fullAccessRefusalWarning({ requested: "read-only", mode: "read-only", roleLabel: "r" })).toBeUndefined();
  });
});

describe("appleSandboxWarning — OS-sandboxed judge on a Swift/Xcode project", () => {
  const base = { hasOsSandbox: true, mode: "workspace-write" as const, apple: true, mechanism: "cli", refused: false, roleLabel: "role-run-evaluator" };

  it("warns for a Codex-style judge under workspace-write, naming the knob and the boundary", () => {
    const w = appleSandboxWarning(base);
    expect(w).toContain("role-run-evaluator");
    expect(w).toContain("'workspace-write'");
    expect(w).toContain("UN-RUN");
    expect(w).toContain("exercise.sandbox: danger-full-access");
    expect(w).toContain("worktree");
  });

  it("warns under read-only too (an in-place run that fell back)", () => {
    expect(appleSandboxWarning({ ...base, mode: "read-only" })).toContain("'read-only'");
  });

  it("warns on exercise.mechanism: ios even when no Swift marker was found", () => {
    expect(appleSandboxWarning({ ...base, apple: false, mechanism: "ios" })).toBeDefined();
  });

  it("is silent with full access, without an OS sandbox (Claude), off Swift, or after a refusal", () => {
    expect(appleSandboxWarning({ ...base, mode: "danger-full-access" })).toBeUndefined();
    expect(appleSandboxWarning({ ...base, hasOsSandbox: false })).toBeUndefined();
    expect(appleSandboxWarning({ ...base, apple: false, mechanism: "cli" })).toBeUndefined();
    expect(appleSandboxWarning({ ...base, mode: "read-only", refused: true })).toBeUndefined();
  });
});
