import { describe, it, expect } from "vitest";
import {
  within,
  firstDeny,
  denyWriteOutsideRoots,
  denyWriteNotFile,
  denyAnyWrite,
  denyBash,
  denyBashMutation,
} from "../src/sdk/scoping.ts";

describe("within", () => {
  it("returns true when child is inside parent", () => {
    expect(within("/a/b/c", "/a/b")).toBe(true);
  });

  it("returns true when child and parent are the same path", () => {
    // path.relative("/a/b", "/a/b") === "" which satisfies rel === "" condition
    expect(within("/a/b", "/a/b")).toBe(true);
  });

  it("returns false for a sibling path", () => {
    expect(within("/a/c", "/a/b")).toBe(false);
  });

  it("returns false when child is above parent", () => {
    expect(within("/a", "/a/b")).toBe(false);
  });
});

describe("denyWriteOutsideRoots", () => {
  it("allows a write whose target is inside the allowed root", () => {
    expect(denyWriteOutsideRoots("Write", { file_path: "/allowed/work/file.ts" }, ["/allowed/work"])).toBeNull();
  });

  it("denies a write whose target is outside the allowed root", () => {
    expect(denyWriteOutsideRoots("Write", { file_path: "/forbidden/file.ts" }, ["/allowed/work"])).not.toBeNull();
  });

  it("CRITICAL: allows any write when writeRoots is empty (early guard)", () => {
    // Safety-critical: empty writeRoots means this decider is not active
    expect(denyWriteOutsideRoots("Write", { file_path: "/any/file.ts" }, [])).toBeNull();
  });

  it("allows non-write tools regardless of roots", () => {
    expect(denyWriteOutsideRoots("Bash", { command: "rm -rf /" }, ["/safe"])).toBeNull();
  });
});

describe("denyWriteNotFile", () => {
  it("allows a write to exactly the allowed file", () => {
    expect(denyWriteNotFile("Write", { file_path: "/abs/target.ts" }, "/abs/target.ts")).toBeNull();
  });

  it("denies a write to a different file", () => {
    expect(denyWriteNotFile("Write", { file_path: "/abs/other.ts" }, "/abs/target.ts")).not.toBeNull();
  });

  it("CRITICAL: denies when input has no file_path property (filePathOf returns undefined)", () => {
    // filePathOf({}) returns undefined, abs becomes "", "" !== allowedFile → deny
    expect(denyWriteNotFile("Write", {}, "/abs/target.ts")).not.toBeNull();
  });

  it("allows non-write tools unconditionally", () => {
    expect(denyWriteNotFile("Bash", { command: "ls" }, "/abs/target.ts")).toBeNull();
  });
});

describe("denyAnyWrite", () => {
  it("denies Write tool", () => {
    expect(denyAnyWrite("Write")).not.toBeNull();
  });

  it("denies Edit tool", () => {
    expect(denyAnyWrite("Edit")).not.toBeNull();
  });

  it("allows Bash (not a write tool)", () => {
    expect(denyAnyWrite("Bash")).toBeNull();
  });
});

describe("denyBash", () => {
  it("denies Bash containing a forbidden substring", () => {
    expect(denyBash("Bash", { command: "git push origin main" }, ["git push"])).not.toBeNull();
  });

  it("CRITICAL: allows when toolName is not Bash (early return)", () => {
    expect(denyBash("Write", { command: "git push" }, ["git push"])).toBeNull();
  });

  it("allows Bash whose command does not contain the forbidden substring", () => {
    expect(denyBash("Bash", { command: "ls /tmp" }, ["git push"])).toBeNull();
  });

  it("CRITICAL: allows Bash when denyContains contains only an empty string (falsy guard)", () => {
    // The `bad &&` guard filters out empty strings
    expect(denyBash("Bash", { command: "rm -rf /" }, [""])).toBeNull();
  });
});

describe("denyBashMutation", () => {
  it("denies rm -rf / (hardcoded mutator)", () => {
    expect(denyBashMutation("Bash", { command: "rm -rf /" }, [])).not.toBeNull();
  });

  it("denies git commit (hardcoded mutator)", () => {
    expect(denyBashMutation("Bash", { command: "git commit -m 'bad'" }, [])).not.toBeNull();
  });

  it("denies > redirection (hardcoded mutator)", () => {
    expect(denyBashMutation("Bash", { command: "echo hi > out.txt" }, [])).not.toBeNull();
  });

  it("denies sed -i (hardcoded mutator)", () => {
    expect(denyBashMutation("Bash", { command: "sed -i 's/a/b/g' file" }, [])).not.toBeNull();
  });

  it("CRITICAL: denies a custom extra string spread into mutators", () => {
    expect(denyBashMutation("Bash", { command: "deploy-prod" }, ["deploy-prod"])).not.toBeNull();
  });

  it("allows ls (not a mutation)", () => {
    expect(denyBashMutation("Bash", { command: "ls /tmp" }, [])).toBeNull();
  });

  it("allows non-Bash tools unconditionally", () => {
    expect(denyBashMutation("Write", { file_path: "/tmp/x" }, [])).toBeNull();
  });
});

describe("firstDeny", () => {
  it("returns null when all deciders return null", () => {
    expect(firstDeny("Write", {}, [() => null, () => null])).toBeNull();
  });

  it("CRITICAL: returns null for an empty deciders array (safe-by-default)", () => {
    expect(firstDeny("Write", {}, [])).toBeNull();
  });

  it("returns the first non-null reason and short-circuits", () => {
    const deciders = [(t: string) => (t === "Write" ? "Denied" : null), () => null];
    expect(firstDeny("Write", {}, deciders)).toBe("Denied");
  });

  it("skips null deciders and returns the first matching one", () => {
    const deciders = [() => null, (t: string) => (t === "Edit" ? "No edits" : null)];
    expect(firstDeny("Edit", {}, deciders)).toBe("No edits");
  });
});
