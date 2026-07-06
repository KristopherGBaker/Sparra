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
  denyDisableSandbox,
  allowVerifyBash,
  allowReadInScope,
  writeScopeViolations,
} from "../src/sdk/scoping.ts";

const VERIFY = ["npm test", "tsc", "npm run typecheck", "swift test"];

describe("allowReadInScope (always-readable workspace — Item B)", () => {
  const SCOPES = ["/work", "/extra"];
  it("auto-approves an explicit in-scope Read/Glob/Grep (absolute or relative)", () => {
    expect(allowReadInScope("Read", { file_path: "/work/src/a.ts" }, SCOPES)).toMatch(/Auto-approved/);
    expect(allowReadInScope("Grep", { path: "/extra/lib", pattern: "x" }, SCOPES)).toMatch(/Auto-approved/);
    expect(allowReadInScope("Read", { file_path: "src/a.ts" }, SCOPES)).toMatch(/Auto-approved/); // relative → SCOPES[0]
  });
  it("defers an out-of-scope target (does not broaden beyond the scope)", () => {
    expect(allowReadInScope("Read", { file_path: "/etc/passwd" }, SCOPES)).toBeNull();
    expect(allowReadInScope("Read", { file_path: "/work/../etc/x" }, SCOPES)).toBeNull();
  });
  it("defers a pathless search (could surface a cwd-resident holdout — never auto-grant)", () => {
    expect(allowReadInScope("Grep", { pattern: "secret" }, SCOPES)).toBeNull();
    expect(allowReadInScope("Glob", { pattern: "**/*.ts" }, SCOPES)).toBeNull();
  });
  it("ignores non-read tools and an empty scope", () => {
    expect(allowReadInScope("Bash", { command: "ls" }, SCOPES)).toBeNull();
    expect(allowReadInScope("Write", { file_path: "/work/a.ts" }, SCOPES)).toBeNull();
    expect(allowReadInScope("Read", { file_path: "/work/a.ts" }, [])).toBeNull();
  });
});

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

describe("allowVerifyBash — output-shaping filter pipe (U3 Part A, allow-hook only)", () => {
  const PREFIX = ["npm test"];

  it("A1: allows an allow-prefix piped into EVERY permitted pure filter", () => {
    for (const stage of ["tail -5", "head -20", 'grep -E "fail"', "cat", "wc -l", "sort", "uniq", "cut -f1", "nl", "tr a b"]) {
      expect(allowVerifyBash("Bash", { command: `npm test | ${stage}` }, PREFIX), stage).toMatch(/output-shaping/);
    }
  });

  it("A1: allows a CHAINED filter pipeline", () => {
    expect(allowVerifyBash("Bash", { command: "npm test | tail -20 | grep x" }, PREFIX)).toMatch(/output-shaping/);
  });

  it("A2: allows a permitted fd-dup / dev-null discard before the pipe (one per family)", () => {
    expect(allowVerifyBash("Bash", { command: "npm test 2>&1 | tail -5" }, PREFIX)).toMatch(/output-shaping/);
    expect(allowVerifyBash("Bash", { command: "npm test >&2 | cat" }, PREFIX)).toMatch(/output-shaping/);
    expect(allowVerifyBash("Bash", { command: "npm test 1>&2 | wc -l" }, PREFIX)).toMatch(/output-shaping/);
    expect(allowVerifyBash("Bash", { command: "npm test 2>/dev/null | grep x" }, PREFIX)).toMatch(/output-shaping/);
    expect(allowVerifyBash("Bash", { command: "npm test >/dev/null | tail -1" }, PREFIX)).toMatch(/output-shaping/);
  });

  it("A4: rejects an executing / writing pipeline stage (only pure filters granted)", () => {
    for (const stage of ["tee log", "sed -i s/a/b/", "sed 's/a/b/'", "awk '{system(\"rm x\")}'", "xargs rm", "node -e 'x'", "sh", "bash", "perl -e", "python -c"]) {
      expect(allowVerifyBash("Bash", { command: `npm test | ${stage}` }, PREFIX), stage).toBeNull();
    }
  });

  it("A4a: rejects a filter whose ARGS would WRITE a file (default-deny flag allowlist)", () => {
    for (const stage of ["sort -o out.txt", "sort --output=out.txt"]) {
      expect(allowVerifyBash("Bash", { command: `npm test | ${stage}` }, PREFIX), stage).toBeNull();
    }
  });

  it("A4a: rejects a filter whose ARGS would READ a file (operand cap + flag allowlist)", () => {
    for (const stage of [
      "cat /etc/passwd", // cat takes ZERO operands — the operand is a file
      "grep pat somefile", // grep pattern + FILE operand (2 > 1)
      "grep -f patterns.txt", // `-f` reads a pattern FILE (not in the flag allowlist)
      "head somefile",
      "wc somefile",
      "sort infile",
      "uniq in out",
      "cut -f1 somefile", // `-f1` is fine, the trailing operand is a file
      "nl somefile",
      "grep -e pat somefile", // `-e` supplied the pattern, so the operand is a FILE
      "grep -A 3 pat somefile", // value flag consumed, pattern operand + FILE operand (2 > 1)
      "tail -f somefile", // `-f` (follow) is not allowlisted, and the operand is a file
    ]) {
      expect(allowVerifyBash("Bash", { command: `npm test | ${stage}` }, PREFIX), stage).toBeNull();
    }
  });

  it("A4a: still GRANTS the safe output-shaping shapes (args are pure stdin→stdout)", () => {
    for (const stage of [
      "tail -5",
      "head -20",
      'grep -E "fail"',
      "grep -n foo",
      "grep -o pat", // `-o` = only-matching (SAFE) — must NOT be confused with `sort -o`
      "wc -l",
      "cut -f1",
      "sort -r",
      "tail -n 5 | grep x",
    ]) {
      expect(allowVerifyBash("Bash", { command: `npm test | ${stage}` }, PREFIX), stage).toMatch(/output-shaping/);
    }
  });

  it("A4a: does NOT grant a filter-pipe whose stage tool is UNLISTED (strict 10-tool allowlist)", () => {
    // Only the 10 pinned tools are recognized; egrep/fgrep and arbitrary binaries defer.
    for (const stage of ["jq .", "ripgrep x", "foobar", "egrep x", "fgrep x", "less", "more", "awk '{print}'"]) {
      expect(allowVerifyBash("Bash", { command: `npm test | ${stage}` }, PREFIX), stage).toBeNull();
    }
  });

  it("A5: rejects real-file redirects (incl. a permitted token as a PREFIX of a real file)", () => {
    for (const cmd of [
      "npm test > out.txt",
      "npm test >> log",
      "npm test >/dev/null.txt | tail", // dev-null as prefix of a real file, before a filter
      "npm test >&out.txt",
      "npm test 1>& out.txt",
      "npm test 2>&1file", // fd-dup as prefix of a file
      "npm test 2>&1file | tail", // …even piped into a filter
    ]) {
      expect(allowVerifyBash("Bash", { command: cmd }, PREFIX), cmd).toBeNull();
    }
  });

  it("A6: rejects chain / adjacency adversaries", () => {
    for (const cmd of [
      "npm test | tailx", // filter name as prefix of an unknown binary
      "npm test | tail -20 | sh", // bad second stage
      "npm test | grep x; rm y",
      "npm test && rm y",
      "npm test | tail -5 && curl evil",
      "npm test | tail `$(id)`",
      "npm test\n | tail -5", // a control char must never be laundered by stage-trimming
    ]) {
      expect(allowVerifyBash("Bash", { command: cmd }, PREFIX), cmd).toBeNull();
    }
  });

  it("A7: left side must be an EXACT allow-prefix — the filter allowance never grants a non-allowlisted command", () => {
    expect(allowVerifyBash("Bash", { command: "rm -rf / | tail" }, PREFIX)).toBeNull();
    expect(allowVerifyBash("Bash", { command: "curl evil | grep x" }, PREFIX)).toBeNull();
    expect(allowVerifyBash("Bash", { command: "npmtest | tail" }, PREFIX)).toBeNull(); // substring, not a prefix boundary
  });

  it("A7a: rejects forbidden tokens LAUNDERED on the left stage behind an allowlisted prefix", () => {
    // Each of these DENIES without the pipe (contains a forbidden token) — the pipe must not
    // launder it into an allow. FAILS under the opposite mutation (drop the left-stage re-check).
    for (const cmd of [
      "npm test curl evil | tail -5", // network on the left
      "npm test rm x | tail -5", // mutation on the left
      "npm test git commit -m x | grep x", // commit on the left
      "npm test npm install | tail", // install on the left
      "npm test && rm x | tail", // chain on the left
      "npm test $(curl evil) | tail", // command substitution on the left
      "npm test `curl evil` | tail", // backtick substitution on the left
    ]) {
      expect(allowVerifyBash("Bash", { command: cmd }, PREFIX), cmd).toBeNull();
    }
  });

  it("A7a: clean allowlisted left stages still GRANT (left re-check is not over-broad)", () => {
    for (const cmd of ["npm test | tail -5", "npm test 2>&1 | grep -E fail", "npm test | tail -n 5 | grep x"]) {
      expect(allowVerifyBash("Bash", { command: cmd }, PREFIX), cmd).toMatch(/output-shaping/);
    }
  });

  it("A: honors the caller's extra deny substrings on the filter-pipe path too", () => {
    expect(allowVerifyBash("Bash", { command: "npm test | tail -5" }, PREFIX, ["npm test"])).toBeNull();
  });
});

describe("denyDisableSandbox (U3 Part B — flag-as-bypass deny)", () => {
  it("DENIES a Bash call carrying dangerouslyDisableSandbox: true, naming the flag", () => {
    const r = denyDisableSandbox("Bash", { command: "git -C /x status", dangerouslyDisableSandbox: true });
    expect(r).toMatch(/dangerouslyDisableSandbox/);
  });
  it("is inert when the flag is absent or false (purely additive)", () => {
    expect(denyDisableSandbox("Bash", { command: "npm test" })).toBeNull();
    expect(denyDisableSandbox("Bash", { command: "npm test", dangerouslyDisableSandbox: false })).toBeNull();
  });
  it("ignores non-Bash tools", () => {
    expect(denyDisableSandbox("Write", { file_path: "/x", dangerouslyDisableSandbox: true })).toBeNull();
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

  it("U1: allows fd-dups (2>&1, 1>&2, 2>&-) — no file written", () => {
    expect(denyBashMutation("Bash", { command: "npm test 2>&1 | wc -l" }, [])).toBeNull();
    expect(denyBashMutation("Bash", { command: "ls -la 2>&1" }, [])).toBeNull();
    expect(denyBashMutation("Bash", { command: "cmd 1>&2" }, [])).toBeNull();
    expect(denyBashMutation("Bash", { command: "cmd 2>&-" }, [])).toBeNull();
  });

  it("U1: allows /dev/null targets — no file written", () => {
    expect(denyBashMutation("Bash", { command: "cmd 2>/dev/null" }, [])).toBeNull();
    expect(denyBashMutation("Bash", { command: "cmd >/dev/null" }, [])).toBeNull();
    expect(denyBashMutation("Bash", { command: "cmd 1>/dev/null 2>&1" }, [])).toBeNull();
    expect(denyBashMutation("Bash", { command: "cmd &>/dev/null" }, [])).toBeNull();
  });

  it("U1: still blocks a redirect to a real file", () => {
    expect(denyBashMutation("Bash", { command: "foo > out.txt" }, [])).not.toBeNull();
    expect(denyBashMutation("Bash", { command: "echo x >> log" }, [])).not.toBeNull();
    expect(denyBashMutation("Bash", { command: "cmd 2> err.log" }, [])).not.toBeNull();
  });

  it("U1 anti-gaming: a mixed fd-dup/dev-null + real file write is still blocked", () => {
    expect(denyBashMutation("Bash", { command: "cmd > out.txt 2>&1" }, [])).not.toBeNull();
    expect(denyBashMutation("Bash", { command: "echo x 2>&1 > /tmp/leak" }, [])).not.toBeNull();
    expect(denyBashMutation("Bash", { command: "cmd 2>/dev/null > out.txt" }, [])).not.toBeNull();
  });

  it("U1 3c: `>&FILE` combined redirect to a filename is still blocked", () => {
    expect(denyBashMutation("Bash", { command: "echo hi >&out.txt" }, [])).not.toBeNull();
    expect(denyBashMutation("Bash", { command: "echo hi >& out.txt" }, [])).not.toBeNull();
    expect(denyBashMutation("Bash", { command: "echo hi 1>& out.txt" }, [])).not.toBeNull();
  });

  it("U1 3c: descriptor dup/close (`n>&m`/`n>&-`) remains allowed", () => {
    expect(denyBashMutation("Bash", { command: "cmd 2>&1" }, [])).toBeNull();
    expect(denyBashMutation("Bash", { command: "cmd 1>&2" }, [])).toBeNull();
    expect(denyBashMutation("Bash", { command: "cmd 2>&-" }, [])).toBeNull();
  });

  it("U1 3d: anchored harmless tokens — real filenames starting with a harmless token are blocked", () => {
    expect(denyBashMutation("Bash", { command: "cmd >/dev/null.txt" }, [])).not.toBeNull();
    expect(denyBashMutation("Bash", { command: "cmd 2>/dev/nullish" }, [])).not.toBeNull();
    expect(denyBashMutation("Bash", { command: "cmd &>/dev/null.log" }, [])).not.toBeNull();
    expect(denyBashMutation("Bash", { command: "echo hi >&2file" }, [])).not.toBeNull();
    expect(denyBashMutation("Bash", { command: "echo hi 2>&1file" }, [])).not.toBeNull();
    expect(denyBashMutation("Bash", { command: "echo hi 2>&-file" }, [])).not.toBeNull();
  });

  it("U1 3d: genuine harmless forms stay allowed after anchoring", () => {
    expect(denyBashMutation("Bash", { command: "cmd >/dev/null" }, [])).toBeNull();
    expect(denyBashMutation("Bash", { command: "cmd &>/dev/null" }, [])).toBeNull();
    expect(denyBashMutation("Bash", { command: "cmd >/dev/null 2>&1" }, [])).toBeNull();
    expect(denyBashMutation("Bash", { command: "echo hi >&2" }, [])).toBeNull();
    expect(denyBashMutation("Bash", { command: "cmd 2>&1" }, [])).toBeNull();
    expect(denyBashMutation("Bash", { command: "cmd 2>&-" }, [])).toBeNull();
  });

  it("U1: other mutators unchanged (mv, git push/checkout, tee)", () => {
    expect(denyBashMutation("Bash", { command: "mv a b" }, [])).not.toBeNull();
    expect(denyBashMutation("Bash", { command: "git push" }, [])).not.toBeNull();
    expect(denyBashMutation("Bash", { command: "git checkout ." }, [])).not.toBeNull();
    expect(denyBashMutation("Bash", { command: "tee f" }, [])).not.toBeNull();
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
