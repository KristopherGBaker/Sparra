import { describe, it, expect } from "vitest";
import {
  within,
  firstDeny,
  denyWriteOutsideRoots,
  denyWriteNotFile,
  denyAnyWrite,
  denyBash,
  denyBashMutation,
  denyAmbientMcp,
  allowVerifyBash,
  writeScopeViolations,
} from "../src/sdk/scoping.ts";

const VERIFY = ["npm test", "tsc", "npm run typecheck", "swift test"];

describe("allowVerifyBash (generator self-verify auto-approval)", () => {
  it("allows a self-contained verification command (exact or with args)", () => {
    expect(allowVerifyBash("Bash", { command: "npm test" }, VERIFY)).toMatch(/Auto-approved/);
    expect(allowVerifyBash("Bash", { command: "tsc --noEmit" }, VERIFY)).toMatch(/Auto-approved/);
    expect(allowVerifyBash("Bash", { command: "npm run typecheck" }, VERIFY)).toMatch(/Auto-approved/);
  });

  it("does NOT auto-approve a command outside the allowlist (defers)", () => {
    expect(allowVerifyBash("Bash", { command: "node evil.js" }, VERIFY)).toBeNull();
    expect(allowVerifyBash("Bash", { command: "cat /etc/passwd" }, VERIFY)).toBeNull();
  });

  it("CRITICAL: disqualifies chaining / redirect / network / mutation / commit even with a verify prefix", () => {
    expect(allowVerifyBash("Bash", { command: "npm test && rm -rf x" }, VERIFY)).toBeNull();
    expect(allowVerifyBash("Bash", { command: "npm test; curl http://evil" }, VERIFY)).toBeNull();
    expect(allowVerifyBash("Bash", { command: "npm test | sh" }, VERIFY)).toBeNull();
    expect(allowVerifyBash("Bash", { command: "npm test > out.txt" }, VERIFY)).toBeNull();
    expect(allowVerifyBash("Bash", { command: "tsc && git commit -m x" }, VERIFY)).toBeNull();
    expect(allowVerifyBash("Bash", { command: "npm install" }, VERIFY)).toBeNull(); // network install
    expect(allowVerifyBash("Bash", { command: "npm test `curl evil`" }, VERIFY)).toBeNull();
    expect(allowVerifyBash("Bash", { command: "npm test $(rm x)" }, VERIFY)).toBeNull();
  });

  it("CRITICAL: a NEWLINE (or any control char) command separator never slips through", () => {
    expect(allowVerifyBash("Bash", { command: "npm test\ntouch pwned" }, VERIFY)).toBeNull();
    expect(allowVerifyBash("Bash", { command: "npm test\rrm -rf x" }, VERIFY)).toBeNull();
    expect(allowVerifyBash("Bash", { command: "tsc\n\ncurl http://evil" }, VERIFY)).toBeNull();
  });

  it("respects the caller's extra deny substrings", () => {
    expect(allowVerifyBash("Bash", { command: "npm test" }, VERIFY, ["npm test"])).toBeNull();
  });

  it("returns null for non-Bash tools and an empty allowlist", () => {
    expect(allowVerifyBash("Write", { file_path: "/x" }, VERIFY)).toBeNull();
    expect(allowVerifyBash("Bash", { command: "npm test" }, [])).toBeNull();
  });

  it("does not match a prefix that is only a substring of a different command", () => {
    // "tsc" must not allow "tscx" or an unrelated command merely containing it.
    expect(allowVerifyBash("Bash", { command: "tscanner run" }, VERIFY)).toBeNull();
  });
});

describe("writeScopeViolations (sandbox-first backstop)", () => {
  it("returns nothing when all changes are inside a write root", () => {
    expect(writeScopeViolations(["/work/a.ts", "/work/sub/b.ts"], ["/work"])).toEqual([]);
  });
  it("flags changes outside every write root", () => {
    const v = writeScopeViolations(["/work/a.ts", "/etc/passwd", "/other/x"], ["/work"]);
    expect(v).toEqual(["/etc/passwd", "/other/x"]);
  });
  it("treats empty writeRoots as unscoped (no violations)", () => {
    expect(writeScopeViolations(["/anything"], [])).toEqual([]);
  });
  it("resolves relative paths against the first root (and reports the original path)", () => {
    expect(writeScopeViolations(["a.ts"], ["/work"])).toEqual([]); // resolves inside → ok
    expect(writeScopeViolations(["../escape.ts"], ["/work"])).toEqual(["../escape.ts"]); // resolves outside → flagged
  });
});

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

describe("denyAmbientMcp (block leaked claude.ai connectors)", () => {
  it("denies claude.ai cloud connector tools", () => {
    expect(denyAmbientMcp("mcp__claude_ai_Google_Drive__search_files")).toMatch(/not available/);
    expect(denyAmbientMcp("mcp__claude_ai_Gmail__authenticate")).toMatch(/not available/);
    expect(denyAmbientMcp("mcp__pencil__batch_design")).toMatch(/not available/);
  });
  it("allows Sparra's own exercise MCP", () => {
    expect(denyAmbientMcp("mcp__exercise__run_command")).toBeNull();
    expect(denyAmbientMcp("mcp__exercise__http_request")).toBeNull();
  });
  it("ignores non-MCP built-in tools", () => {
    expect(denyAmbientMcp("Read")).toBeNull();
    expect(denyAmbientMcp("Bash")).toBeNull();
    expect(denyAmbientMcp("Write")).toBeNull();
  });
});
