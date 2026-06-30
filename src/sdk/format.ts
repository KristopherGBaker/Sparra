import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { PostToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { WRITE_TOOLS } from "./scoping.ts";
import type { HookConfig } from "./hooks.ts";
import { warn } from "../util/log.ts";

export type FormatMode = "greenfield" | "existing";

export interface FormatOptions {
  /** Master switch; when false makeFormatHook returns no hook at all. */
  enabled: boolean;
  /** Explicit command with an optional `{file}` placeholder. Empty → auto-detect. */
  command: string;
  /** Auto-detect a formatter by file type when `command` is empty. */
  autodetect: boolean;
  /** greenfield → prettier-style defaults; existing → prefer formatters named in the map. */
  mode: FormatMode;
  /** CODEBASE_MAP.md contents (existing repos), used to detect the project's formatter. */
  codebaseMap?: string | null;
  /** Project/workspace root — the upper bound (inclusive) for the upward config-file search an
   *  AUTODETECTED formatter requires (e.g. `.swiftformat`). When absent the search walks to the
   *  filesystem root, as the tool itself would. */
  workspaceRoot?: string;
}

/** Injectable seams so the runner is testable without real formatters installed. */
export interface FormatDeps {
  /** Run argv; defaults to spawnSync. Return shape mirrors the bits we care about. */
  exec?: (argv: string[]) => { status: number | null; error?: Error };
  warn?: (msg: string) => void;
  /** Existence probe for the upward config search; defaults to fs.existsSync. */
  fileExists?: (p: string) => boolean;
}

export interface FormatResult {
  ran: boolean;
  formatter?: string;
  warning?: string;
}

function filePathOf(input: any): string | undefined {
  return (input?.file_path ?? input?.path ?? input?.notebook_path) as string | undefined;
}

function mapMentions(map: string | null | undefined, name: string): boolean {
  return !!map && map.toLowerCase().includes(name);
}

/** Known prettier-style extensions (the prettier/biome formatter family). */
const PRETTIER_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".jsonc",
  ".css", ".scss", ".less", ".html", ".vue", ".md", ".mdx", ".yaml", ".yml", ".graphql",
]);

/**
 * Config-file candidates per formatter. An AUTODETECTED formatter auto-applies ONLY when one of its
 * candidates is discoverable up-tree from the file (see {@link findConfigUp}); without it, stock rules
 * churn diffs on a repo that doesn't format that way, so we run NOTHING (no greenfield exception).
 * Existence-probe only — we deliberately do NOT read file CONTENTS, so e.g. a prettier config expressed
 * solely as a `"prettier"` key in `package.json` is not detected (set `format.command` to opt in).
 * swiftlint (a linter `--fix`, not a reformatter) is exempt and carries no entry here.
 */
const FORMATTER_CONFIGS: Record<string, string[]> = {
  swiftformat: [".swiftformat"],
  prettier: [
    ".prettierrc", ".prettierrc.json", ".prettierrc.yml", ".prettierrc.yaml", ".prettierrc.json5",
    ".prettierrc.toml", ".prettierrc.js", ".prettierrc.cjs", ".prettierrc.mjs",
    "prettier.config.js", "prettier.config.cjs", "prettier.config.mjs",
  ],
  biome: ["biome.json", "biome.jsonc"],
  black: ["pyproject.toml"],
  ruff: ["pyproject.toml", "ruff.toml", ".ruff.toml"],
  gofmt: ["go.mod"],
  rustfmt: ["rustfmt.toml", ".rustfmt.toml"],
};

/**
 * True when ANY of the config files `names` is discoverable by walking UP from the formatted file's
 * own directory through its TRUE ancestors, to (and including) `stopAt` — or to the filesystem root if
 * `stopAt` isn't an ancestor. Mirrors how a tool finds its own config up the tree; only ancestors are
 * visited, never an unrelated sibling subtree. The single I/O seam (`exists`) is injectable for tests.
 */
export function findConfigUp(filePath: string, names: string | string[], stopAt: string | undefined, exists: (p: string) => boolean): boolean {
  const candidates = Array.isArray(names) ? names : [names];
  let dir = path.dirname(path.resolve(filePath));
  const stop = stopAt ? path.resolve(stopAt) : undefined;
  for (let prev = ""; dir !== prev; prev = dir, dir = path.dirname(dir)) {
    if (candidates.some((n) => exists(path.join(dir, n)))) return true;
    if (stop && dir === stop) break; // reached the workspace root (inclusive) — don't over-reach
  }
  return false;
}

/** A candidate formatter for an extension. `lint` = a linter `--fix` (not config-gated, and only ever
 *  selected when the map mentions it); `mentionOnly` = eligible only via a map mention, never as the
 *  per-language default (preserves the original default tool per language). */
interface Candidate {
  tool: string;
  argv: string[];
  lint?: boolean;
  mentionOnly?: boolean;
}

/** Ordered candidate formatters for a file extension (preference order). */
function candidatesFor(ext: string, filePath: string): Candidate[] {
  if (ext === ".swift")
    return [
      { tool: "swiftformat", argv: ["swiftformat", filePath] },
      { tool: "swiftlint", argv: ["swiftlint", "--fix", filePath], lint: true, mentionOnly: true },
    ];
  if (PRETTIER_EXTS.has(ext))
    return [
      { tool: "biome", argv: ["biome", "format", "--write", filePath], mentionOnly: true },
      { tool: "prettier", argv: ["prettier", "--write", filePath] },
    ];
  if (ext === ".py")
    return [
      { tool: "ruff", argv: ["ruff", "format", filePath], mentionOnly: true },
      { tool: "black", argv: ["black", filePath] },
    ];
  if (ext === ".go") return [{ tool: "gofmt", argv: ["gofmt", "-w", filePath] }];
  if (ext === ".rs") return [{ tool: "rustfmt", argv: ["rustfmt", filePath] }];
  return [];
}

/**
 * Decide the formatter argv for a file, or null if none applies. The touched file path is the last
 * argument. The only I/O is the AUTODETECT config probe (an explicit `format.command` is pure); both
 * are injectable via `deps` so the choice is unit-testable.
 */
export function chooseFormatter(filePath: string, opts: FormatOptions, deps: FormatDeps = {}): string[] | null {
  // 1) Explicit command always wins (an explicit opt-in is NOT subject to the autodetect config gate).
  if (opts.command && opts.command.trim()) {
    const parts = opts.command.trim().split(/\s+/);
    const hasPlaceholder = parts.some((p) => p.includes("{file}"));
    const argv = hasPlaceholder ? parts.map((p) => p.replace("{file}", filePath)) : [...parts, filePath];
    return argv;
  }
  if (!opts.autodetect) return null;

  const ext = path.extname(filePath).toLowerCase();
  const map = opts.codebaseMap;
  const exists = deps.fileExists ?? ((p: string) => fs.existsSync(p));
  // An AUTODETECTED reformatter only resolves when its config is discoverable up-tree (file's dir →
  // true ancestors → workspace root). A linter `--fix` (swiftlint) isn't gated. Greenfield/no-config
  // therefore resolves NOTHING — no per-language exception.
  const ok = (c: Candidate) => c.lint || findConfigUp(filePath, FORMATTER_CONFIGS[c.tool] ?? [], opts.workspaceRoot, exists);

  const candidates = candidatesFor(ext, filePath);

  // 2) Existing repos: prefer a formatter the codebase map actually mentions (still config-gated).
  if (opts.mode === "existing" && map) {
    for (const c of candidates.filter((c) => mapMentions(map, c.tool))) {
      if (ok(c)) return c.argv;
    }
  }

  // 3) Per-language default (greenfield, or existing with no usable map hint) — reformatters only,
  //    config-gated. `mentionOnly` tools (biome/ruff/swiftlint) never fire as a bare default.
  for (const c of candidates) {
    if (c.mentionOnly) continue;
    if (ok(c)) return c.argv;
  }

  return null;
}

function looksMissing(r: { status: number | null; error?: Error }): boolean {
  if (r.error && ((r.error as any).code === "ENOENT" || /ENOENT/.test(r.error.message))) return true;
  return r.status === 127; // shell "command not found"
}

/**
 * Format a single file. Never throws and never fails the build: a missing
 * formatter (or any error) becomes a warning + no-op. Returns what happened.
 */
export function runFormatter(filePath: string, opts: FormatOptions, deps: FormatDeps = {}): FormatResult {
  const emit = deps.warn ?? warn;
  const exec =
    deps.exec ??
    ((argv: string[]) => {
      const r = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8" });
      return { status: r.status, error: r.error };
    });

  try {
    const argv = chooseFormatter(filePath, opts, deps);
    if (!argv) {
      const msg = `No formatter found for ${path.basename(filePath)}; skipping (set format.command to configure one).`;
      emit(msg);
      return { ran: false, warning: msg };
    }
    const r = exec(argv);
    if (looksMissing(r) || (r.status != null && r.status !== 0)) {
      const why = looksMissing(r) ? "not installed" : `exited ${r.status}`;
      const msg = `Formatter "${argv[0]}" ${why}; skipping format of ${path.basename(filePath)}.`;
      emit(msg);
      return { ran: false, formatter: argv[0], warning: msg };
    }
    return { ran: true, formatter: argv[0] };
  } catch (e) {
    // Belt and suspenders — formatting must never break the build.
    const msg = `Formatting ${path.basename(filePath)} failed (${(e as Error).message}); skipping.`;
    emit(msg);
    return { ran: false, warning: msg };
  }
}

/**
 * Build a PostToolUse hook that formats/lints each file the model writes via
 * Write/Edit. Returns an empty config (no hook) when formatting is disabled. The
 * hook always resolves to {} so it can never block or fail a tool call.
 */
export function makeFormatHook(opts: FormatOptions, deps: FormatDeps = {}): HookConfig {
  if (!opts.enabled) return {};
  return {
    PostToolUse: [
      {
        hooks: [
          async (input) => {
            try {
              const post = input as PostToolUseHookInput;
              if (!WRITE_TOOLS.has(post.tool_name)) return {};
              const fp = filePathOf(post.tool_input);
              if (!fp) return {};
              runFormatter(fp, opts, deps);
            } catch {
              // never surface a formatting error to the SDK
            }
            return {};
          },
        ],
      },
    ],
  };
}
