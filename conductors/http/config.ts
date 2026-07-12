/**
 * `conductors/http/config.ts` — load + validate the HTTP bridge's `bridge.yaml`, and resolve the
 * bind address.
 *
 * The bridge is a LOCAL HTTP service that lets a remote agent (over Tailscale) trigger Sparra on
 * this Mac. This module is the config half of the safety spine: it refuses to start without an
 * explicit allowlist of project roots, and `resolveBind` NEVER yields a public wildcard address.
 *
 * Node built-ins + existing `zod`/`yaml` only — no new dependency.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import YAML from "yaml";
import { z } from "zod";

/** The validated, defaulted bridge configuration. */
export interface BridgeConfig {
  /** Allowlist of absolute project-root paths. The single source of truth for `paths.ts`. */
  roots: string[];
  /** TCP port to listen on. */
  port: number;
  /** Explicit bind-address override (still refused if it resolves to a wildcard). */
  bind?: string;
  /** Max retained jobs in the in-memory store. */
  lastNJobs: number;
  /** Where the append-only request audit log is written. */
  auditLogPath: string;
  /** Consumed by a later unit; loaded + exposed here only. */
  allowRemotePlan: boolean;
}

const bridgeConfigSchema = z.object({
  roots: z
    .array(z.string())
    .min(1, "bridge.yaml `roots` must list at least one absolute project root"),
  port: z.number().int().positive().default(8787),
  bind: z.string().optional(),
  lastNJobs: z.number().int().positive().default(50),
  auditLogPath: z.string().optional(),
  allowRemotePlan: z.boolean().default(false),
});

const DEFAULT_CONFIG_REL = join(".sparra", "bridge.yaml");
const DEFAULT_AUDIT_REL = join(".sparra", "bridge-audit.log");

/** Injectable seams so tests never touch real env/disk. */
export interface LoadBridgeConfigDeps {
  env?: NodeJS.ProcessEnv;
  /** Read the config file's text; throws (ENOENT) when missing. */
  readFile?: (path: string) => string;
  /** Home directory used to expand `~` and compute defaults. */
  home?: string;
}

/** Expand a leading `~` (or `~/`) to the given home directory; other paths pass through. */
function expandTilde(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(home, p.slice(2));
  return p;
}

/**
 * Load + validate `bridge.yaml` (path from `$SPARRA_BRIDGE_CONFIG`, default `~/.sparra/bridge.yaml`).
 *
 * A missing config file, empty/missing `roots`, or a non-absolute root is a STARTUP ERROR (throws) —
 * the service must never come up without an explicit allowlist.
 */
export function loadBridgeConfig(deps: LoadBridgeConfigDeps = {}): BridgeConfig {
  const env = deps.env ?? process.env;
  const home = deps.home ?? homedir();
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, "utf8"));

  const rawPath = env.SPARRA_BRIDGE_CONFIG?.trim();
  const configPath = rawPath ? expandTilde(rawPath, home) : join(home, DEFAULT_CONFIG_REL);

  let text: string;
  try {
    text = readFile(configPath);
  } catch (e) {
    throw new Error(`bridge config not found or unreadable at ${configPath}: ${(e as Error).message}`);
  }

  let parsedYaml: unknown;
  try {
    parsedYaml = YAML.parse(text);
  } catch (e) {
    throw new Error(`Could not parse bridge config ${configPath}: ${(e as Error).message}`);
  }

  const result = bridgeConfigSchema.safeParse(parsedYaml);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid bridge config ${configPath}: ${detail}`);
  }
  const data = result.data;

  const roots = data.roots.map((r) => expandTilde(r, home));
  for (const root of roots) {
    // A non-absolute root is a startup error: the path guard's prefix check is only meaningful
    // against absolute roots, so we refuse anything that could be interpreted relative to a cwd.
    if (!isAbsolute(root)) {
      throw new Error(`Invalid bridge config ${configPath}: root "${root}" is not an absolute path`);
    }
  }

  const auditLogPath = data.auditLogPath
    ? expandTilde(data.auditLogPath, home)
    : join(home, DEFAULT_AUDIT_REL);

  const config: BridgeConfig = {
    roots,
    port: data.port,
    lastNJobs: data.lastNJobs,
    auditLogPath,
    allowRemotePlan: data.allowRemotePlan,
  };
  if (data.bind !== undefined) config.bind = data.bind;
  return config;
}

/** A bind address that would expose the service on every interface — never allowed. */
const WILDCARD_BINDS = new Set(["0.0.0.0", "::", "0000:0000:0000:0000:0000:0000:0000:0000"]);

/** Injectable seams for `resolveBind` so tests never shell out to `tailscale`. */
export interface ResolveBindDeps {
  env?: NodeJS.ProcessEnv;
  /** Resolve this host's Tailscale IPv4 (first line, trimmed); `undefined` when unavailable. */
  tailscaleIp?: () => string | undefined;
}

/** Default `tailscale ip -4` resolver: first line, trimmed; `undefined` on any failure. */
function defaultTailscaleIp(): string | undefined {
  try {
    const out = execFileSync("tailscale", ["ip", "-4"], { encoding: "utf8" });
    const first = out.split("\n")[0]?.trim();
    return first && first.length > 0 ? first : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the address to bind: `$SPARRA_BRIDGE_BIND` → `config.bind` → injected tailscale resolver →
 * `127.0.0.1`.
 *
 * HARD RULE: the resolved address must NEVER be a wildcard (`0.0.0.0` / `::`) — that would expose the
 * bridge on every interface, defeating the Tailscale-only threat model. If the chosen source yields a
 * wildcard we THROW rather than silently falling through to loopback, so a misconfiguration fails
 * loudly instead of quietly binding public.
 */
export function resolveBind(config: Pick<BridgeConfig, "bind">, deps: ResolveBindDeps = {}): string {
  const env = deps.env ?? process.env;
  const tailscaleIp = deps.tailscaleIp ?? defaultTailscaleIp;

  const envBind = env.SPARRA_BRIDGE_BIND?.trim();
  const configBind = config.bind?.trim();

  let resolved: string;
  if (envBind && envBind.length > 0) resolved = envBind;
  else if (configBind && configBind.length > 0) resolved = configBind;
  else {
    const ts = tailscaleIp()?.trim();
    resolved = ts && ts.length > 0 ? ts : "127.0.0.1";
  }

  if (WILDCARD_BINDS.has(resolved)) {
    throw new Error(
      `refusing to bind the Sparra bridge to wildcard address "${resolved}" — set a specific ` +
        `Tailscale/loopback address via SPARRA_BRIDGE_BIND or bridge.yaml \`bind\``,
    );
  }
  return resolved;
}
