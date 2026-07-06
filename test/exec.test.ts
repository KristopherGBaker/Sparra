import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { runVerifyCommand, unsafeExecReason, extractVerifyCommands, classifyExec, rerunVerifyCommands, type ExecOutcome } from "../src/build/exec.ts";
import { allowVerifyBash } from "../src/sdk/scoping.ts";

/**
 * Q3: the harness-side no-model executor. Real-command tests use ONLY local built-ins
 * (`true`/`false`/`echo`/`ls`) — no network, no model calls. `spawnFn` is dependency-injected
 * (a spy wrapping the real spawn) so the safety tests PROVE an unsafe command never spawns.
 */

describe("U3 Part A: the executor path stays strict where the allow-hook loosened (deliberate divergence)", () => {
  const spySpawn = () =>
    vi.fn((...args: Parameters<typeof spawn>) => spawn(...args)) as unknown as typeof spawn & { mock: { calls: unknown[] } };

  it("unsafeExecReason STILL rejects a filter pipe — the executor spawns argv directly, no shell", async () => {
    // The allow-hook grants the filter-pipe shape (Claude Bash runs a real shell)…
    expect(allowVerifyBash("Bash", { command: "npm test | tail -5" }, ["npm test"])).toMatch(/output-shaping/);
    // …but the harness executor must NOT — a pipe would become bogus argv to `npm`.
    expect(unsafeExecReason("npm test | tail -5", ["npm test"])).not.toBeNull();
    expect(unsafeExecReason("npm test 2>&1 | tail -5", ["npm test"])).not.toBeNull();
    // …and it never actually spawns the pipeline.
    const spawnFn = spySpawn();
    const o = await runVerifyCommand(os.tmpdir(), "npm test | tail -5", { spawnFn, allowPrefixes: ["npm test"] });
    expect(o.ran).toBe(false);
    expect(spawnFn).not.toHaveBeenCalled();
  });
});

describe("runVerifyCommand — safety rules (shared with the self-verify allow-path)", () => {
  /** Spy that passes through to the real spawn — counts every actual process launch. */
  const spySpawn = () =>
    vi.fn((...args: Parameters<typeof spawn>) => spawn(...args)) as unknown as typeof spawn & { mock: { calls: unknown[] } };
  const unsafe = [
    "echo a && echo b",
    "echo a; echo b",
    "cat x | grep y",
    "echo hi > out.txt",
    "curl https://example.com",
    "npm install left-pad",
    "git commit -m x",
    "rm -rf scratch",
  ];

  it("rejects chaining/redirect/network/mutation/commit commands WITHOUT spawning", async () => {
    const spawnFn = spySpawn();
    for (const cmd of unsafe) {
      const o = await runVerifyCommand(os.tmpdir(), cmd, { spawnFn });
      expect(o.ran).toBe(false);
      if (!o.ran) expect(o.unsafeReason).toBeTruthy();
    }
    expect(spawnFn).not.toHaveBeenCalled(); // the spy proves NO execution happened
  });

  it("executes a plain allowed command and returns exit 0 + stdout", async () => {
    const spawnFn = spySpawn();
    const o = await runVerifyCommand(os.tmpdir(), "echo ok", { spawnFn });
    expect(o.ran).toBe(true);
    if (o.ran) {
      expect(o.exitCode).toBe(0);
      expect(o.stdout).toContain("ok");
      expect(o.timedOut).toBe(false);
    }
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });

  it("rejects a BARE `rm` (argv[0] basename allowlist, not substring) without spawning", async () => {
    const spawnFn = spySpawn();
    for (const cmd of ["rm", "/bin/rm", "git", "npx vitest run x.ts", "sh -c true", "bash", "sudo ls", "node -e 1+1", "node --eval 1+1"]) {
      const o = await runVerifyCommand(os.tmpdir(), cmd, { spawnFn });
      expect(o.ran, cmd).toBe(false);
      if (!o.ran) expect(o.unsafeReason).toBeTruthy();
    }
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it("ALLOWLIST posture: mutating commands with clean argv0s are unsafe pre-spawn and the fs is untouched (real fs)", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-exec-allow-"));
    const victim = path.join(ws, "victim.txt");
    fs.writeFileSync(victim, "still here");
    const spawnFn = spySpawn();
    const find = await runVerifyCommand(ws, "find victim.txt -delete", { spawnFn });
    expect(find.ran).toBe(false); // find is not a build/test runner — never spawned…
    expect(fs.existsSync(victim)).toBe(true); // …and the victim survives
    const touch = await runVerifyCommand(ws, "touch created.txt", { spawnFn });
    expect(touch.ran).toBe(false);
    expect(fs.existsSync(path.join(ws, "created.txt"))).toBe(false); // no file created
    const perl = await runVerifyCommand(ws, "perl -e unlink victim.txt", { spawnFn });
    expect(perl.ran).toBe(false);
    expect(fs.existsSync(victim)).toBe(true);
    expect(spawnFn).not.toHaveBeenCalled(); // the spy proves NONE of them ever spawned
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it("rejects interpreter eval escapes and unknown tools pre-spawn; `python -m <module>` passes the gate", async () => {
    const spawnFn = spySpawn();
    for (const cmd of ["python -c pass", "python3 -c pass", "python script.py", "tsx -e 1", "bun --eval 1", "mycooltool test", "awk -f x.awk", "sed -n 1p file", "ruby x.rb", "npm exec rm -rf x", "pnpm dlx cowsay hi"]) {
      const o = await runVerifyCommand(os.tmpdir(), cmd, { spawnFn });
      expect(o.ran, cmd).toBe(false);
      if (!o.ran) expect(o.unsafeReason).toBeTruthy();
    }
    expect(spawnFn).not.toHaveBeenCalled();
    // python ONLY with -m <module> as the first args — allowed and spawned tokenized (fake spawn).
    const fake = fakeSpawn();
    const py = await runVerifyCommand("/ws", "python -m pytest", { spawnFn: fake });
    expect(py.ran && py.exitCode === 0).toBe(true);
    expect(fake.mock.calls[0]![0]).toBe("python");
    expect(fake.mock.calls[0]![1]).toEqual(["-m", "pytest"]);
  });

  it("build.verifyCommands opt-in: the SAME unknown tool becomes allowed when the user declared it (prefix semantics)", async () => {
    const fake = fakeSpawn();
    const denied = await runVerifyCommand("/ws", "mycooltool test", { spawnFn: fake });
    expect(denied.ran).toBe(false); // unknown tool → unsafe by default…
    const optedIn = await runVerifyCommand("/ws", "mycooltool test --fast", { spawnFn: fake, allowPrefixes: ["mycooltool test"] });
    expect(optedIn.ran && optedIn.exitCode === 0).toBe(true); // …explicit opt-in allows it
    expect(fake.mock.calls).toHaveLength(1);
    expect(fake.mock.calls[0]![0]).toBe("mycooltool");
    // Prefix match is word-boundary shaped: "mycooltool testx" does NOT match "mycooltool test".
    const nearMiss = await runVerifyCommand("/ws", "mycooltool testx", { spawnFn: fake, allowPrefixes: ["mycooltool test"] });
    expect(nearMiss.ran).toBe(false);
    // The opt-in never bypasses the shared/metachar rules — a declared prefix still can't chain.
    const chained = await runVerifyCommand("/ws", "mycooltool test && rm -rf x", { spawnFn: fake, allowPrefixes: ["mycooltool test"] });
    expect(chained.ran).toBe(false);
    expect(fake.mock.calls).toHaveLength(1); // still only the opted-in spawn
  });

  it("rejects shell-expansion forms pre-spawn: rm${IFS}victim.txt never runs and the file survives (real fs)", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-exec-ifs-"));
    const victim = path.join(ws, "victim.txt");
    fs.writeFileSync(victim, "still here");
    const spawnFn = spySpawn();
    // NOT a template literal — the executor receives the literal ${IFS} expansion token.
    const o = await runVerifyCommand(ws, "rm${IFS}victim.txt", { spawnFn });
    expect(o.ran).toBe(false);
    if (!o.ran) expect(o.unsafeReason).toContain("$");
    expect(spawnFn).not.toHaveBeenCalled(); // never spawned…
    expect(fs.existsSync(victim)).toBe(true); // …and the workspace file survives
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it("SUBCOMMAND safety: `npm version patch --no-git-tag-version` is unsafe pre-spawn and package.json is UNCHANGED (real fs)", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-exec-pm-"));
    const pkg = path.join(ws, "package.json");
    fs.writeFileSync(pkg, JSON.stringify({ name: "victim", version: "1.0.0" }));
    const spawnFn = spySpawn();
    const o = await runVerifyCommand(ws, "npm version patch --no-git-tag-version", { spawnFn });
    expect(o.ran).toBe(false); // a mutating subcommand through an allowlisted binary — never spawned…
    if (!o.ran) expect(o.unsafeReason).toContain("npm version");
    expect(spawnFn).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(pkg, "utf8")).version).toBe("1.0.0"); // …and the version survives
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it("package managers permit ONLY test / run <script> / run-script <script>: every other verb and BARE invocations are unsafe", async () => {
    const spawnFn = spySpawn();
    const unsafePm = [
      "npm", "yarn", "pnpm", "bun", // bare invocation (yarn/pnpm/bun install by default)
      "npm version patch", "npm publish --dry-run", "npm link", "npm cache clean --force",
      "npm config set registry x", "npm pack", "npm ci", "npm install", "npm update",
      "yarn add left-pad", "yarn remove x", "yarn init", "pnpm update", "pnpm i", "pnpm add x",
      "bun install", "bun add x", "npm run", "yarn run-script", // run/run-script need a script name
    ];
    for (const cmd of unsafePm) {
      const o = await runVerifyCommand(os.tmpdir(), cmd, { spawnFn });
      expect(o.ran, cmd).toBe(false);
      if (!o.ran) expect(o.unsafeReason).toBeTruthy();
    }
    expect(spawnFn).not.toHaveBeenCalled(); // the spy proves NONE of them ever spawned
  });

  it("safe verb forms still spawn: npm test / npm run build / pnpm test / bun test / python -m pytest / tsc --noEmit", async () => {
    const fake = fakeSpawn();
    for (const cmd of ["npm test", "npm run build", "npm run-script lint", "pnpm test", "yarn test", "bun test", "python -m pytest", "tsc --noEmit"]) {
      const o = await runVerifyCommand("/ws", cmd, { spawnFn: fake });
      expect(o.ran && o.exitCode === 0, cmd).toBe(true);
    }
    expect(fake.mock.calls).toHaveLength(8);
    expect(fake.mock.calls[1]![0]).toBe("npm");
    expect(fake.mock.calls[1]![1]).toEqual(["run", "build"]);
  });

  it("denies the concrete mutating first verbs of the other runners (cargo publish, go clean, mvn deploy, …); their test/build verbs still spawn", async () => {
    const spawnFn = spySpawn();
    for (const cmd of ["cargo publish", "cargo install ripgrep", "go clean -cache", "go get x", "dotnet nuget push x.nupkg", "mvn deploy", "mvn install", "gradle publish", "gradle publishToMavenLocal"]) {
      const o = await runVerifyCommand(os.tmpdir(), cmd, { spawnFn });
      expect(o.ran, cmd).toBe(false);
      if (!o.ran) expect(o.unsafeReason).toContain("mutating");
    }
    expect(spawnFn).not.toHaveBeenCalled();
    const fake = fakeSpawn();
    for (const cmd of ["cargo test", "go test ./...", "dotnet test", "mvn verify", "gradle build"]) {
      const o = await runVerifyCommand("/ws", cmd, { spawnFn: fake });
      expect(o.ran && o.exitCode === 0, cmd).toBe(true);
    }
  });

  it("build.verifyCommands opt-in still works for a mutating subcommand the user EXPLICITLY declared", async () => {
    const fake = fakeSpawn();
    const optedIn = await runVerifyCommand("/ws", "npm version patch --no-git-tag-version", {
      spawnFn: fake,
      allowPrefixes: ["npm version"], // the user's explicit declaration, not the default
    });
    expect(optedIn.ran && optedIn.exitCode === 0).toBe(true);
    expect(fake.mock.calls).toHaveLength(1);
  });

  it("rejects command-substitution / chaining / backtick forms pre-spawn", async () => {
    const spawnFn = spySpawn();
    for (const cmd of ["echo $(whoami)", "npm test; rm x", "echo `whoami`", "echo ~/x", "echo a\\ b", 'echo "hi"', "echo {a,b}"]) {
      const o = await runVerifyCommand(os.tmpdir(), cmd, { spawnFn });
      expect(o.ran, cmd).toBe(false);
    }
    expect(spawnFn).not.toHaveBeenCalled();
  });

  /** Fake spawn: an EventEmitter child that exits 0 — proves WHAT would be spawned without running it. */
  const fakeSpawn = () =>
    vi.fn((..._args: unknown[]) => {
      const child = new EventEmitter() as any;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from("ok"));
        child.emit("close", 0);
      });
      return child;
    }) as unknown as typeof spawn & { mock: { calls: any[][] } };

  it("spawns argv DIRECTLY (no shell): `npm test` / `tsc --noEmit` pass the gate and spawn tokenized", async () => {
    const spawnFn = fakeSpawn();
    const npm = await runVerifyCommand("/ws", "npm test", { spawnFn });
    expect(npm.ran && npm.exitCode === 0).toBe(true);
    const tsc = await runVerifyCommand("/ws", "tsc --noEmit", { spawnFn });
    expect(tsc.ran && tsc.exitCode === 0).toBe(true);
    expect(spawnFn.mock.calls[0]![0]).toBe("npm");
    expect(spawnFn.mock.calls[0]![1]).toEqual(["test"]);
    expect(spawnFn.mock.calls[1]![0]).toBe("tsc");
    expect(spawnFn.mock.calls[1]![1]).toEqual(["--noEmit"]);
    for (const call of spawnFn.mock.calls) expect(call[2]).not.toHaveProperty("shell"); // no shell, ever
  });

  it("captures a nonzero exit (`false`) without throwing", async () => {
    const o = await runVerifyCommand(os.tmpdir(), "false");
    expect(o.ran).toBe(true);
    if (o.ran) expect(o.exitCode).not.toBe(0);
  });

  it("runs with cwd=workspace: a relative path resolves against the workspace (7b)", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-exec-ws-"));
    fs.writeFileSync(path.join(ws, "only-here.txt"), "x");
    // `ls` is not a build/test runner — opt it in via allowPrefixes (build.verifyCommands),
    // which also exercises the escape hatch against a REAL spawn.
    const allowPrefixes = ["ls"];
    const inWs = await runVerifyCommand(ws, "ls only-here.txt", { allowPrefixes });
    expect(inWs.ran && inWs.exitCode === 0).toBe(true);
    const elsewhere = await runVerifyCommand(os.tmpdir(), "ls only-here.txt", { allowPrefixes });
    expect(elsewhere.ran && elsewhere.exitCode !== 0).toBe(true);
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it("bounds captured output to the cap", async () => {
    const o = await runVerifyCommand(os.tmpdir(), "echo aaaaaaaaaaaaaaaaaaaa", { outputCap: 5 });
    expect(o.ran).toBe(true);
    if (o.ran) expect(o.stdout.length).toBeLessThanOrEqual(5);
  });
});

describe("classifyExec — usage vs behavioral vs ok", () => {
  const c = (exitCode: number | null, stderr = "", stdout = "") => classifyExec({ exitCode, stdout, stderr });

  it("discriminates every contract case", () => {
    expect(c(127, "zsh: command not found: mytool")).toBe("usage"); // exit 127 → usage
    expect(c(2, "usage: mytool [--profile <p>]")).toBe("usage"); // exit 2 + usage text → usage
    expect(c(1, "error: unknown option --bogus")).toBe("usage"); // unknown-flag stderr → usage
    expect(c(2, "assertion failed: expected 5 got 3")).toBe("behavioral"); // exit 2, NON-usage → behavioral
    expect(c(1, "test suite failed: 3 failing")).toBe("behavioral"); // plain exit 1 → behavioral
    expect(c(0)).toBe("ok"); // exit 0 → ok
  });
});

describe("extractVerifyCommands — bounded to the 'I will verify by' section", () => {
  it("extracts backticked-in-prose AND plain list-item commands (exactly those 3)", () => {
    const md = [
      "# Contract — x",
      "## I will build",
      "- stuff with `not-a-verify-command`",
      "## I will verify by",
      "Run `npm run typecheck` first (exit 0).",
      "- npm test → exit 0",
      "- `mytool add 2 3` prints `5`, exits 0",
      "## Assertions",
      "1. `some-other-command --flag` exits 0.",
      "- assertion list item command",
    ].join("\n");
    expect(extractVerifyCommands(md)).toEqual(["npm run typecheck", "npm test", "mytool add 2 3"]);
  });

  it("yields [] when the section is absent (no probe)", () => {
    expect(extractVerifyCommands("# Contract\n## Assertions\n- `npm test` exits 0\n")).toEqual([]);
  });

  it("yields [] for an empty section (stops at the immediately-following heading)", () => {
    expect(extractVerifyCommands("## I will verify by\n## Assertions\n- `npm test`\n")).toEqual([]);
  });
});

describe("rerunVerifyCommands — the rerun-gate core over an injected executor", () => {
  const ran = (exitCode: number, command = "npm test"): ExecOutcome => ({ ran: true, command, exitCode, stdout: "", stderr: exitCode ? "boom" : "", timedOut: false });

  it("mixed exits → flaky; all nonzero → failing; all zero → ok; unsafe → unsafe (not retried, demotes like failing)", async () => {
    const seq = [0, 1]; // flaky
    let i = 0;
    const flaky = await rerunVerifyCommands("/ws", ["npm test"], 2, async () => ran(seq[i++]!));
    expect(flaky[0]!.status).toBe("flaky");

    const failing = await rerunVerifyCommands("/ws", ["npm test"], 2, async () => ran(1));
    expect(failing[0]!.status).toBe("failing");

    const okRes = await rerunVerifyCommands("/ws", ["npm test"], 2, async () => ran(0));
    expect(okRes[0]!.status).toBe("ok");

    const spy = vi.fn(async (): Promise<ExecOutcome> => ({ ran: false, command: "a && b", unsafeReason: "chain" }));
    const unsafe = await rerunVerifyCommands("/ws", ["a && b"], 3, spy);
    expect(unsafe[0]!.status).toBe("unsafe"); // its own non-ok class — the gate demotes it like failing
    expect(unsafe[0]!.detail).toContain("a && b"); // detail names the command for the blocking feedback
    expect(spy).toHaveBeenCalledTimes(1); // unsafe is deterministic — no retry
  });

  it("a mutating SUBCOMMAND as the contracted verify command is demoted by the REAL executor — never a silent [0,0]-clean (real fs)", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-exec-rerun-pm-"));
    const pkg = path.join(ws, "package.json");
    fs.writeFileSync(pkg, JSON.stringify({ name: "victim", version: "1.0.0" }));
    const results = await rerunVerifyCommands(ws, ["npm version patch --no-git-tag-version"], 2, runVerifyCommand);
    expect(results[0]!.status).toBe("unsafe"); // demoted — the gate treats any non-ok as blocking
    expect(results[0]!.exitCodes).toEqual([]); // never ran, so never the silent [0,0]
    expect(results[0]!.detail).toContain("npm version"); // blocking feedback names the command
    expect(JSON.parse(fs.readFileSync(pkg, "utf8")).version).toBe("1.0.0"); // and nothing mutated
    fs.rmSync(ws, { recursive: true, force: true });
  });
});
