/**
 * `conductors/http/setup.test.ts` — exercises the bridge-lifecycle setup logic (`setup.ts`) with
 * FULLY injected deps: an in-memory fs, a recording launchctl exec, deterministic randomness, and a
 * captured home/checkout. No real `$HOME`, no launchctl, no network, no sockets — every effect is
 * observed through a recorder. Mirrors `bridgeScript.test.ts`/`config.test.ts` DI discipline.
 *
 * The REAL `com.sparra.bridge.plist.example` + `bridge.yaml.example` shipped in this directory are the
 * render inputs (a repo read, deterministic — never `$HOME`), so the render test proves the shipped
 * template has no placeholder the renderer misses.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { realDeps, runSetup, type SetupDeps } from "./setup.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const REAL_TEMPLATE = readFileSync(path.join(here, "com.sparra.bridge.plist.example"), "utf8");
const REAL_YAML_EXAMPLE = readFileSync(path.join(here, "bridge.yaml.example"), "utf8");

const HOME = "/home/tester";
const CHECKOUT = "/checkout";
const EXECPATH = "/opt/node/bin/node";

const PLIST = `${HOME}/Library/LaunchAgents/com.sparra.bridge.plist`;
const BRIDGE_YAML = `${HOME}/.sparra/bridge.yaml`;
const TEMPLATE_PATH = `${CHECKOUT}/conductors/http/com.sparra.bridge.plist.example`;
const YAML_EXAMPLE_PATH = `${CHECKOUT}/conductors/http/bridge.yaml.example`;
const BIN_PATH = `${CHECKOUT}/bin/sparra-bridge.mjs`;

interface Recorder {
  stdout: string[];
  stderr: string[];
  writes: { path: string; content: string; mode?: number }[];
  removes: string[];
  exec: { command: string; args: string[] }[];
}

/** Build a fresh set of injected deps over an in-memory fs, plus the recorder observing effects. */
function makeDeps(opts?: {
  template?: string;
  seedFiles?: Record<string, string>;
  tokens?: string[];
  /** Override the launchctl exit status per invocation (default: always 0). */
  execStatus?: (command: string, args: string[]) => number;
}): { deps: SetupDeps; rec: Recorder; files: Map<string, { content: string; mode?: number }> } {
  const files = new Map<string, { content: string; mode?: number }>();
  files.set(TEMPLATE_PATH, { content: opts?.template ?? REAL_TEMPLATE });
  files.set(YAML_EXAMPLE_PATH, { content: REAL_YAML_EXAMPLE });
  for (const [p, content] of Object.entries(opts?.seedFiles ?? {})) files.set(p, { content });

  const rec: Recorder = { stdout: [], stderr: [], writes: [], removes: [], exec: [] };
  const tokens = [...(opts?.tokens ?? ["a".repeat(64), "b".repeat(64)])];

  const deps: SetupDeps = {
    stdout: (line) => rec.stdout.push(line),
    stderr: (line) => rec.stderr.push(line),
    fs: {
      exists: (p) => files.has(p),
      readFile: (p) => {
        const f = files.get(p);
        if (!f) throw new Error(`ENOENT: ${p}`);
        return f.content;
      },
      writeFile: (p, content, o) => {
        files.set(p, { content, mode: o?.mode });
        rec.writes.push({ path: p, content, mode: o?.mode });
      },
      mkdirp: () => {},
      removeFile: (p) => {
        files.delete(p);
        rec.removes.push(p);
      },
    },
    exec: {
      run: (command, args) => {
        rec.exec.push({ command, args });
        return { status: opts?.execStatus?.(command, args) ?? 0 };
      },
    },
    paths: { home: HOME, checkout: CHECKOUT, execPath: EXECPATH },
    randomToken: () => tokens.shift() ?? "z".repeat(64),
  };
  return { deps, rec, files };
}

/** Pull the SPARRA_BRIDGE_TOKEN out of a rendered plist. */
function tokenIn(plist: string): string | undefined {
  return /<key>SPARRA_BRIDGE_TOKEN<\/key>\s*<string>([^<]*)<\/string>/.exec(plist)?.[1];
}

describe("runSetup install — rendering + placeholder guard", () => {
  it("renders every placeholder with real values; NO REPLACE_WITH / /Users/example survives", async () => {
    const { deps, rec, files } = makeDeps({ tokens: ["cafef00d".repeat(8)] });
    const code = await runSetup(["install"], deps);
    expect(code).toBe(0);

    const plist = files.get(PLIST)!.content;
    expect(plist).not.toMatch(/REPLACE_WITH/);
    expect(plist).not.toContain("/Users/example");
    // real values present
    expect(plist).toContain(`<string>${EXECPATH}</string>`);
    expect(plist).toContain(`<string>${BIN_PATH}</string>`);
    expect(plist).toContain(`<string>${CHECKOUT}</string>`); // WorkingDirectory
    expect(plist).toContain(`${HOME}/Library/Logs/sparra-bridge.log`);
    expect(plist).toContain(`${HOME}/Library/Logs/sparra-bridge.err.log`);
    expect(plist).toContain(`<string>${BRIDGE_YAML}</string>`); // SPARRA_BRIDGE_CONFIG
    expect(tokenIn(plist)).toBe("cafef00d".repeat(8));

    // wrote to the LaunchAgents path with mode 0600
    const w = rec.writes.find((x) => x.path === PLIST)!;
    expect(w.mode).toBe(0o600);
    // unload (tolerated) then load
    expect(rec.exec).toEqual([
      { command: "launchctl", args: ["unload", PLIST] },
      { command: "launchctl", args: ["load", PLIST] },
    ]);
  });

  it("FAILS loudly with ZERO plist-write / launchctl when an unknown placeholder survives", async () => {
    const brokenTemplate = REAL_TEMPLATE.replace(
      "</dict>\n</plist>",
      "\t<key>Extra</key>\n\t<string>REPLACE_WITH_SOMETHING_NEW</string>\n</dict>\n</plist>",
    );
    const { deps, rec, files } = makeDeps({ template: brokenTemplate });
    const code = await runSetup(["install"], deps);
    expect(code).not.toBe(0);
    expect(rec.stderr.join("\n")).toMatch(/placeholder/i);
    expect(files.has(PLIST)).toBe(false);
    expect(rec.writes.some((w) => w.path === PLIST)).toBe(false);
    expect(rec.exec).toEqual([]); // no launchctl at all
  });
});

describe("runSetup install — token lifecycle", () => {
  it("preserves an existing real token on idempotent re-install (different randomness ignored)", async () => {
    const { deps, files } = makeDeps({ tokens: ["1".repeat(64), "2".repeat(64)] });
    await runSetup(["install"], deps); // token "111…"
    const first = tokenIn(files.get(PLIST)!.content);
    expect(first).toBe("1".repeat(64));
    await runSetup(["install"], deps); // would-be "222…" ignored; existing preserved
    expect(tokenIn(files.get(PLIST)!.content)).toBe(first);
  });

  it("--rotate-token replaces the existing token", async () => {
    const { deps, files } = makeDeps({ tokens: ["1".repeat(64), "2".repeat(64)] });
    await runSetup(["install"], deps);
    await runSetup(["install", "--rotate-token"], deps);
    expect(tokenIn(files.get(PLIST)!.content)).toBe("2".repeat(64));
  });

  it("emits the token EXACTLY once (export line) and in NO other sink", async () => {
    const tok = "deadbeef".repeat(8);
    const { deps, rec, files } = makeDeps({ tokens: [tok] });
    await runSetup(["install"], deps);

    const stdoutAll = rec.stdout.join("\n");
    const occurrences = stdoutAll.split(tok).length - 1;
    expect(occurrences).toBe(1);
    expect(stdoutAll).toContain(`export SPARRA_BRIDGE_TOKEN=${tok}`);
    // label + health hint present
    expect(stdoutAll).toMatch(/token/i);
    expect(stdoutAll).toMatch(/health/i);
    // token NOWHERE else: not stderr, not launchctl args, not any written file except the plist
    expect(rec.stderr.join("\n")).not.toContain(tok);
    for (const e of rec.exec) expect(e.args.join(" ")).not.toContain(tok);
    for (const w of rec.writes) {
      if (w.path === PLIST) expect(w.content).toContain(tok);
      else expect(w.content).not.toContain(tok);
    }
    expect(files.get(BRIDGE_YAML)!.content).not.toContain(tok);
  });
});

describe("runSetup install — bridge.yaml seed-once", () => {
  it("seeds bridge.yaml from the example with roots=this checkout when ABSENT", async () => {
    const { deps, files } = makeDeps();
    await runSetup(["install"], deps);
    const yaml = files.get(BRIDGE_YAML)!.content;
    expect(yaml).toContain(`  - ${CHECKOUT}`);
    expect(yaml).not.toContain("/Users/example/code/my-app"); // example roots replaced
    expect(yaml).toMatch(/roots:/);
    expect(yaml).toMatch(/Add your other project roots/i); // guidance comment
  });

  it("NEVER clobbers a user-modified bridge.yaml (byte-identical preserved, distinct content)", async () => {
    const custom = "roots:\n  - /my/own/edited/project\nport: 9999\n# hand-edited, do not touch\n";
    const { deps, rec, files } = makeDeps({ seedFiles: { [BRIDGE_YAML]: custom } });
    await runSetup(["install"], deps);
    expect(files.get(BRIDGE_YAML)!.content).toBe(custom); // byte-identical
    expect(rec.writes.some((w) => w.path === BRIDGE_YAML)).toBe(false); // never rewritten
  });
});

describe("runSetup update / remove", () => {
  it("update restarts (unload+load) and touches NEITHER plist NOR bridge.yaml", async () => {
    const custom = "roots:\n  - /x\n";
    const { deps, rec, files } = makeDeps({
      seedFiles: { [PLIST]: "installed-plist", [BRIDGE_YAML]: custom },
    });
    const code = await runSetup(["update"], deps);
    expect(code).toBe(0);
    expect(rec.exec).toEqual([
      { command: "launchctl", args: ["unload", PLIST] },
      { command: "launchctl", args: ["load", PLIST] },
    ]);
    expect(rec.writes).toEqual([]);
    expect(rec.removes).toEqual([]);
    expect(files.get(PLIST)!.content).toBe("installed-plist");
    expect(files.get(BRIDGE_YAML)!.content).toBe(custom);
  });

  it("remove unloads (tolerated) + deletes the plist but keeps bridge.yaml", async () => {
    const custom = "roots:\n  - /x\n";
    const { deps, rec, files } = makeDeps({
      seedFiles: { [PLIST]: "installed-plist", [BRIDGE_YAML]: custom },
    });
    const code = await runSetup(["remove"], deps);
    expect(code).toBe(0);
    expect(rec.exec[0]).toEqual({ command: "launchctl", args: ["unload", PLIST] });
    expect(files.has(PLIST)).toBe(false);
    expect(rec.removes).toContain(PLIST);
    expect(files.get(BRIDGE_YAML)!.content).toBe(custom); // untouched
  });
});

describe("runSetup — launchctl load failure is NOT success", () => {
  it("install: a non-zero `load` returns non-zero, does not claim loaded, and never prints the token", async () => {
    const tok = "feed".repeat(16);
    const { deps, rec, files } = makeDeps({
      tokens: [tok],
      // unload tolerated (0); load fails (nonzero) — as when the plist is malformed / already loaded.
      execStatus: (_command, args) => (args[0] === "load" ? 3 : 0),
    });
    const code = await runSetup(["install"], deps);
    expect(code).not.toBe(0);
    // plist WAS written (mode 0600) before the load attempt — the failure is only the load.
    expect(files.has(PLIST)).toBe(true);
    expect(rec.writes.find((w) => w.path === PLIST)!.mode).toBe(0o600);
    // must NOT claim the agent loaded, and the token must appear in NO stdio sink.
    const stdoutAll = rec.stdout.join("\n");
    expect(stdoutAll).not.toMatch(/installed and loaded/i);
    expect(stdoutAll).not.toContain(tok);
    expect(rec.stderr.join("\n")).not.toContain(tok);
    expect(rec.stderr.join("\n")).toMatch(/load failed/i);
    // both launchctl calls were still attempted (unload tolerated, then load).
    expect(rec.exec).toEqual([
      { command: "launchctl", args: ["unload", PLIST] },
      { command: "launchctl", args: ["load", PLIST] },
    ]);
  });

  it("install: succeeds when load succeeds even though unload fails (unload tolerated)", async () => {
    const { deps, rec } = makeDeps({
      execStatus: (_command, args) => (args[0] === "unload" ? 1 : 0),
    });
    const code = await runSetup(["install"], deps);
    expect(code).toBe(0);
    expect(rec.stdout.join("\n")).toMatch(/installed and loaded/i);
  });

  it("update: a non-zero `load` returns non-zero and does not claim restarted", async () => {
    const { deps, rec } = makeDeps({
      seedFiles: { [PLIST]: "installed-plist" },
      execStatus: (_command, args) => (args[0] === "load" ? 5 : 0),
    });
    const code = await runSetup(["update"], deps);
    expect(code).not.toBe(0);
    expect(rec.stdout.join("\n")).not.toMatch(/restarted/i);
    expect(rec.stderr.join("\n")).toMatch(/load failed/i);
  });
});

describe("runSetup — CLOSED CLI rule", () => {
  const bad: string[][] = [
    [],
    ["bogus"],
    ["install", "--bogus"],
    ["install", "extra"],
    ["install", "--rotate-token", "extra"],
    ["update", "--rotate-token"],
    ["remove", "--rotate-token"],
    ["update", "x"],
    ["remove", "x"],
  ];

  for (const argv of bad) {
    it(`rejects ${JSON.stringify(argv)} with usage, non-zero, and ZERO effects`, async () => {
      const { deps, rec, files } = makeDeps();
      const before = new Set(files.keys());
      const code = await runSetup(argv, deps);
      expect(code).not.toBe(0);
      expect(rec.stderr.join("\n")).toMatch(/usage/i);
      expect(rec.writes).toEqual([]);
      expect(rec.removes).toEqual([]);
      expect(rec.exec).toEqual([]);
      expect(new Set(files.keys())).toEqual(before); // no fs mutation
    });
  }

  const good: string[][] = [["install"], ["install", "--rotate-token"], ["update"], ["remove"]];
  for (const argv of good) {
    it(`accepts ${JSON.stringify(argv)}`, async () => {
      // seed a plist so update/remove have something to act on
      const { deps } = makeDeps({ seedFiles: { [PLIST]: "installed-plist" } });
      const code = await runSetup(argv, deps);
      expect(code).toBe(0);
    });
  }
});

describe("realDeps().fs.writeFile — production mode semantics (real temp fs, no $HOME)", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "sparra-setup-mode-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it("chmods to 0600 when OVERWRITING an already-permissive (0644) file, not only on create", () => {
    const target = path.join(tmp, "com.sparra.bridge.plist");
    // Simulate a plist left over from an earlier install (or created under a loose umask) as 0644.
    writeFileSync(target, "<plist>old</plist>");
    chmodSync(target, 0o644);
    expect(statSync(target).mode & 0o777).toBe(0o644);

    // Re-install path: writeFile with mode 0600 must CORRECT the existing permissive mode.
    realDeps().fs.writeFile(target, "<plist>new</plist>", { mode: 0o600 });
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(readFileSync(target, "utf8")).toBe("<plist>new</plist>");
  });

  it("writes a fresh file as 0600", () => {
    const target = path.join(tmp, "fresh.plist");
    realDeps().fs.writeFile(target, "x", { mode: 0o600 });
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });
});

describe("bin/sparra-bridge-setup.mjs — real-bin smoke (the ONE real-bin gate)", () => {
  it("exits non-zero with usage on a bogus subcommand", () => {
    // Real tsx spawn (no $HOME/launchctl reached — invalid argv touches only stderr). UN-RUN if the
    // tsx binary isn't present in this environment, never a failure. Mirrors packaging.test.ts.
    const bin = path.resolve(here, "../../bin/sparra-bridge-setup.mjs");
    const res = spawnSync("node", [bin, "bogus"], { encoding: "utf8" });
    if (res.error) return; // node/tsx unavailable — UN-RUN
    expect(res.status).not.toBe(0);
    expect(`${res.stderr ?? ""}${res.stdout ?? ""}`).toMatch(/usage/i);
  });
});
