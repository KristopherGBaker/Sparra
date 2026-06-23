import { spawnSync } from "node:child_process";
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
}

/** Injectable seams so the runner is testable without real formatters installed. */
export interface FormatDeps {
  /** Run argv; defaults to spawnSync. Return shape mirrors the bits we care about. */
  exec?: (argv: string[]) => { status: number | null; error?: Error };
  warn?: (msg: string) => void;
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

/** Known prettier-style extensions (the greenfield default formatter). */
const PRETTIER_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".jsonc",
  ".css", ".scss", ".less", ".html", ".vue", ".md", ".mdx", ".yaml", ".yml", ".graphql",
]);

/**
 * Decide the formatter argv for a file, or null if none applies. Pure — no I/O —
 * so the choice is unit-testable. The touched file path is the last argument.
 */
export function chooseFormatter(filePath: string, opts: FormatOptions): string[] | null {
  // 1) Explicit command always wins.
  if (opts.command && opts.command.trim()) {
    const parts = opts.command.trim().split(/\s+/);
    const hasPlaceholder = parts.some((p) => p.includes("{file}"));
    const argv = hasPlaceholder ? parts.map((p) => p.replace("{file}", filePath)) : [...parts, filePath];
    return argv;
  }
  if (!opts.autodetect) return null;

  const ext = path.extname(filePath).toLowerCase();
  const map = opts.codebaseMap;

  // 2) Existing repos: prefer a formatter the codebase map actually mentions.
  if (opts.mode === "existing" && map) {
    if (ext === ".swift") {
      if (mapMentions(map, "swiftformat")) return ["swiftformat", filePath];
      if (mapMentions(map, "swiftlint")) return ["swiftlint", "--fix", filePath];
    }
    if (PRETTIER_EXTS.has(ext)) {
      if (mapMentions(map, "biome")) return ["biome", "format", "--write", filePath];
      if (mapMentions(map, "prettier")) return ["prettier", "--write", filePath];
    }
    if (ext === ".py") {
      if (mapMentions(map, "ruff")) return ["ruff", "format", filePath];
      if (mapMentions(map, "black")) return ["black", filePath];
    }
    if (ext === ".go" && mapMentions(map, "gofmt")) return ["gofmt", "-w", filePath];
    if (ext === ".rs" && mapMentions(map, "rustfmt")) return ["rustfmt", filePath];
  }

  // 3) Sensible per-language defaults (greenfield, or existing with no map hint).
  if (ext === ".swift") return ["swiftformat", filePath];
  if (PRETTIER_EXTS.has(ext)) return ["prettier", "--write", filePath];
  if (ext === ".py") return ["black", filePath];
  if (ext === ".go") return ["gofmt", "-w", filePath];
  if (ext === ".rs") return ["rustfmt", filePath];

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
    const argv = chooseFormatter(filePath, opts);
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
