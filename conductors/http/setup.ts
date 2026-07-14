/**
 * `conductors/http/setup.ts` — one-command lifecycle for the Sparra HTTP bridge LaunchAgent.
 *
 * Replaces the old copy-template-then-hand-edit Makefile flow: `install` auto-derives every plist
 * value (node path, absolute bin path, working directory, log paths, config path) and a crypto-random
 * Bearer token, renders `com.sparra.bridge.plist.example` in place, asserts NO placeholder survived,
 * seeds `~/.sparra/bridge.yaml` once, writes the plist mode 0600, and (re)loads it via launchctl —
 * handing the token to the operator ONCE on stdout. `update` restarts; `remove` unloads + deletes the
 * plist (keeping bridge.yaml).
 *
 * All I/O is dependency-injected ({@link SetupDeps}) so the test suite never touches launchctl, the
 * real `$HOME`, the network, or a socket. {@link realDeps} wires the production implementations
 * (`node:crypto` `randomBytes(32)` token, real fs, real launchctl exec). The CLI is a CLOSED rule
 * enforced in {@link runSetup}: only `install`, `install --rotate-token`, `update`, and `remove` are
 * accepted; anything else prints usage, returns non-zero, and has ZERO fs/exec effects.
 */

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Filesystem surface the setup logic needs — injected so tests never touch the real disk. */
export interface SetupFs {
  exists(p: string): boolean;
  readFile(p: string): string;
  writeFile(p: string, content: string, opts?: { mode?: number }): void;
  mkdirp(p: string): void;
  removeFile(p: string): void;
}

/** launchctl (or any subprocess) runner — injected so tests never spawn a real process. */
export interface SetupExec {
  run(command: string, args: string[]): { status: number };
}

/** Everything {@link runSetup} touches. Invalid argv touches ONLY `stdout`/`stderr`. */
export interface SetupDeps {
  stdout(line: string): void;
  stderr(line: string): void;
  fs: SetupFs;
  exec: SetupExec;
  paths: { home: string; checkout: string; execPath: string };
  /** Fresh Bearer token source (production: `node:crypto` `randomBytes(32)` → 64-hex). */
  randomToken(): string;
}

const USAGE = [
  "usage: sparra-bridge-setup <install [--rotate-token] | update | remove>",
  "  install [--rotate-token]  render + load the bridge LaunchAgent (auto-derives every value;",
  "                            preserves an existing token unless --rotate-token)",
  "  update                    restart the service (unload + load) to pick up new code/config",
  "  remove                    unload + delete the plist (keeps ~/.sparra/bridge.yaml)",
].join("\n");

/** The installed LaunchAgent plist path, derived from the injected home directory. */
function plistPathFor(home: string): string {
  return path.join(home, "Library", "LaunchAgents", "com.sparra.bridge.plist");
}

/** The user's bridge.yaml path, derived from the injected home directory. */
function bridgeYamlPathFor(home: string): string {
  return path.join(home, ".sparra", "bridge.yaml");
}

type Parsed =
  | { ok: true; command: "install"; rotateToken: boolean }
  | { ok: true; command: "update" | "remove" }
  | { ok: false };

/**
 * CLOSED-rule argv parse: the ONLY accepted forms are `install`, `install --rotate-token`, `update`,
 * and `remove`. Everything else — unknown commands/flags, extra positionals, `--rotate-token` on
 * update/remove, empty argv — is rejected by exclusion (not an enumerated bad-list).
 */
function parseArgv(argv: string[]): Parsed {
  const [command, ...rest] = argv;
  if (command === "install") {
    if (rest.length === 0) return { ok: true, command, rotateToken: false };
    if (rest.length === 1 && rest[0] === "--rotate-token") {
      return { ok: true, command, rotateToken: true };
    }
    return { ok: false };
  }
  if (command === "update" || command === "remove") {
    if (rest.length === 0) return { ok: true, command };
    return { ok: false };
  }
  return { ok: false };
}

/** The placeholder strings in the example plist, mapped to their real rendered values. */
function placeholderMap(v: {
  execPath: string;
  binPath: string;
  checkout: string;
  token: string;
  configPath: string;
  logPath: string;
  errLogPath: string;
}): Record<string, string> {
  // launchd's default PATH omits nvm/Homebrew node; the bridge re-execs `tsx` via a
  // `#!/usr/bin/env node` shebang, so node's bin dir must be on PATH or the service crash-loops
  // (`env: node: No such file`). Prepend the running node's dir to the system PATH.
  const nodeBinPath = `${path.dirname(v.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`;
  return {
    "/Users/example/code/Sparra/bin/sparra-bridge.mjs": v.binPath,
    "/Users/example/code/Sparra": v.checkout,
    "/usr/local/bin/node": v.execPath,
    REPLACE_WITH_A_LONG_RANDOM_SECRET_TOKEN: v.token,
    REPLACE_WITH_NODE_BIN_PATH: nodeBinPath,
    "/Users/example/.sparra/bridge.yaml": v.configPath,
    "/Users/example/Library/Logs/sparra-bridge.err.log": v.errLogPath,
    "/Users/example/Library/Logs/sparra-bridge.log": v.logPath,
  };
}

/** Render the plist template, replacing longest placeholder keys first (bin path before checkout). */
function renderPlist(template: string, map: Record<string, string>): string {
  let out = template;
  for (const key of Object.keys(map).sort((a, b) => b.length - a.length)) {
    out = out.split(key).join(map[key]);
  }
  return out;
}

/**
 * Post-render guard: any surviving template placeholder (`REPLACE_WITH…` or a `/Users/example` path)
 * means the template grew a new field the renderer doesn't fill. Return it so `install` fails loudly
 * BEFORE writing the plist or touching launchctl, rather than loading a broken service.
 */
function survivingPlaceholder(rendered: string): string | undefined {
  if (rendered.includes("REPLACE_WITH")) return "REPLACE_WITH…";
  if (rendered.includes("/Users/example")) return "/Users/example…";
  return undefined;
}

/** Extract an existing REAL (non-placeholder) token from an installed plist, or undefined. */
function extractToken(plist: string): string | undefined {
  const m = /<key>SPARRA_BRIDGE_TOKEN<\/key>\s*<string>([^<]*)<\/string>/.exec(plist);
  if (!m) return undefined;
  const val = (m[1] ?? "").trim();
  if (val.length === 0 || val.includes("REPLACE_WITH")) return undefined;
  return val;
}

/** Seed a fresh bridge.yaml from the example, pointing `roots` at THIS checkout. */
function seedBridgeYaml(example: string, checkout: string): string {
  return example.replace(
    /roots:\n(?:[ \t]+-[ \t].*\n)+/,
    `roots:\n  - ${checkout}\n  # Add your other project roots below (absolute paths), one per line.\n`,
  );
}

function doInstall(deps: SetupDeps, rotateToken: boolean): number {
  const { fs, exec, paths } = deps;
  const checkout = paths.checkout;
  const home = paths.home;

  const templatePath = path.join(checkout, "conductors", "http", "com.sparra.bridge.plist.example");
  const yamlExamplePath = path.join(checkout, "conductors", "http", "bridge.yaml.example");
  const binPath = path.join(checkout, "bin", "sparra-bridge.mjs");
  const plistPath = plistPathFor(home);
  const bridgeYamlPath = bridgeYamlPathFor(home);
  const logPath = path.join(home, "Library", "Logs", "sparra-bridge.log");
  const errLogPath = path.join(home, "Library", "Logs", "sparra-bridge.err.log");

  // Token: preserve an existing real token for an idempotent re-install, unless --rotate-token.
  const existing = fs.exists(plistPath) ? extractToken(fs.readFile(plistPath)) : undefined;
  const token = existing && !rotateToken ? existing : deps.randomToken();

  const template = fs.readFile(templatePath);
  const rendered = renderPlist(
    template,
    placeholderMap({ execPath: paths.execPath, binPath, checkout, token, configPath: bridgeYamlPath, logPath, errLogPath }),
  );

  const leftover = survivingPlaceholder(rendered);
  if (leftover) {
    deps.stderr(
      `✗ plist template still contains a placeholder (${leftover}) after rendering — refusing to write. ` +
        "The template grew a field the setup renderer does not fill; update conductors/http/setup.ts.",
    );
    return 1; // no plist write, no launchctl
  }

  // Seed bridge.yaml ONCE — never clobber an operator's edited config.
  if (!fs.exists(bridgeYamlPath)) {
    fs.mkdirp(path.dirname(bridgeYamlPath));
    fs.writeFile(bridgeYamlPath, seedBridgeYaml(fs.readFile(yamlExamplePath), checkout));
  }

  // The plist holds the secret token → mode 0600.
  fs.mkdirp(path.dirname(plistPath));
  fs.writeFile(plistPath, rendered, { mode: 0o600 });

  // Restart: unload is tolerated (fails if not currently loaded), but a non-zero LOAD means the
  // agent did NOT start — surface it and return non-zero rather than claim success.
  exec.run("launchctl", ["unload", plistPath]);
  const loaded = exec.run("launchctl", ["load", plistPath]);
  if (loaded.status !== 0) {
    // The plist (mode 0600, token inside) was written; only the load failed. Do NOT print the token
    // to stdout here — re-running `install` preserves it from the plist and prints it on success.
    deps.stderr(
      `✗ launchctl load failed (exit ${loaded.status}) for ${plistPath} — the plist was written ` +
        "but the LaunchAgent did not start. Fix the reported cause, then re-run `make bridge-install` " +
        "(the token is preserved).",
    );
    return loaded.status || 1;
  }

  // Hand the token to the operator ONCE. It lives ONLY in the plist otherwise — never logged.
  deps.stdout(`✓ Sparra bridge installed and loaded → ${plistPath}`);
  deps.stdout(
    "Bridge Bearer token (shown once; stored only in the plist above, never written to a log or another file):",
  );
  deps.stdout(`  export SPARRA_BRIDGE_TOKEN=${token}`);
  deps.stdout(
    "Paste that into your client shell, then health-check the service: curl http://<your-tailnet-host>:8787/health",
  );
  return 0;
}

function doUpdate(deps: SetupDeps): number {
  const plistPath = plistPathFor(deps.paths.home);
  if (!deps.fs.exists(plistPath)) {
    deps.stderr(`✗ ${plistPath} is not installed — run \`install\` first.`);
    return 1;
  }
  deps.exec.run("launchctl", ["unload", plistPath]); // tolerated if not currently loaded
  const loaded = deps.exec.run("launchctl", ["load", plistPath]);
  if (loaded.status !== 0) {
    deps.stderr(
      `✗ launchctl load failed (exit ${loaded.status}) for ${plistPath} — the bridge did not restart.`,
    );
    return loaded.status || 1;
  }
  deps.stdout(`↻ Sparra bridge restarted (${plistPath}).`);
  return 0;
}

function doRemove(deps: SetupDeps): number {
  const plistPath = plistPathFor(deps.paths.home);
  deps.exec.run("launchctl", ["unload", plistPath]); // tolerated if not loaded
  if (deps.fs.exists(plistPath)) deps.fs.removeFile(plistPath);
  deps.stdout(`✓ Sparra bridge removed — deleted ${plistPath} (kept ${bridgeYamlPathFor(deps.paths.home)}).`);
  return 0;
}

/**
 * The single choke point. Parses argv under the CLOSED rule, then dispatches. Never throws on bad
 * argv (resolves non-zero); invalid argv touches ONLY `stdout`/`stderr`.
 */
export async function runSetup(argv: string[], deps: SetupDeps): Promise<number> {
  const parsed = parseArgv(argv);
  if (!parsed.ok) {
    deps.stderr(USAGE);
    return 1;
  }
  switch (parsed.command) {
    case "install":
      return doInstall(deps, parsed.rotateToken);
    case "update":
      return doUpdate(deps);
    case "remove":
      return doRemove(deps);
  }
}

/** Production dependency wiring: real crypto/fs/launchctl and `os.homedir()`/`process.execPath`. */
export function realDeps(): SetupDeps {
  const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  return {
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    fs: {
      exists: (p) => existsSync(p),
      readFile: (p) => readFileSync(p, "utf8"),
      writeFile: (p, content, opts) => {
        writeFileSync(p, content);
        // `writeFileSync`'s `mode` option only applies when CREATING the file — on a re-install over
        // an existing (possibly 0644) plist it is ignored. chmod unconditionally so the secret-bearing
        // plist is 0600 every time, correcting an already-permissive mode.
        if (opts?.mode !== undefined) chmodSync(p, opts.mode);
      },
      mkdirp: (p) => {
        mkdirSync(p, { recursive: true });
      },
      removeFile: (p) => rmSync(p, { force: true }),
    },
    exec: {
      run: (command, args) => {
        const res = spawnSync(command, args, { stdio: "ignore" });
        return { status: res.status ?? 1 };
      },
    },
    paths: { home: homedir(), checkout, execPath: process.execPath },
    randomToken: () => randomBytes(32).toString("hex"),
  };
}

/**
 * CLI entry: runs ONLY when invoked as the entry script (via the `sparra-bridge-setup` bin, which
 * shells out to tsx) — never on a plain `import`, so tests importing this file never spawn launchctl.
 * Mirrors `server.ts`'s `isEntry` guard.
 */
const isEntry =
  !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  runSetup(process.argv.slice(2), realDeps())
    .then((code) => process.exit(code))
    .catch((e) => {
      process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    });
}
