import YAML from "yaml";
import { readText, writeText, exists } from "./util/io.ts";
import type { Paths } from "./paths.ts";

/** Model alias accepted by the SDK ('opus' | 'sonnet' | 'haiku' | 'fable') or a full model id. */
export type ModelRef = string;

export interface RoleConfig {
  model: ModelRef;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
}

export type ExerciseMechanism = "cli" | "web" | "ios" | "computer-use" | "custom";
export type DeviationStrictness = "strict" | "moderate" | "free";
export type GitStrategy = "worktree" | "branch" | "inplace";
export type PermissionPreset = "auto" | "acceptEdits" | "plan" | "safe-auto" | "default" | "bypass";

export interface SparraConfig {
  /** Per-role models + reasoning effort. The whole point of the harness is mixing models. */
  roles: {
    orienter: RoleConfig;
    planner: RoleConfig;
    prototyper: RoleConfig;
    contractGenerator: RoleConfig;
    contractEvaluator: RoleConfig;
    generator: RoleConfig;
    evaluator: RoleConfig;
    reflector: RoleConfig;
  };

  permission: {
    /**
     * Autonomous-role permission policy. A PreToolUse deny-hook ALWAYS enforces
     * work-scope + dangerous-Bash limits regardless of this value.
     *   auto       → SDK model-classifier approvals IF available on your plan,
     *                else acceptEdits. (default, recommended)
     *   acceptEdits→ auto-accept edits (deny-hook still scopes them)
     *   plan       → read/explore only, no writes
     *   bypass     → NOT allowed; Sparra refuses and uses the safe fallback
     *   safe-auto / default → legacy aliases, treated like 'auto'
     */
    mode: PermissionPreset;
    /** Bash command substrings that are always denied (by the deny-hook). */
    denyBashContains: string[];
  };

  git: {
    /** worktree (recommended for existing repos) | branch | inplace. */
    strategy: GitStrategy;
    branchPrefix: string;
    /** Never true by default: Sparra never commits to your main branch autonomously. */
    autoCommit: boolean;
  };

  rubric: {
    /** Weights need not sum to 1; they are normalized at scoring time. */
    weights: { design: number; originality: number; craft: number; functionality: number };
    /** 0..100. An item round must reach this weighted score to pass. */
    passThreshold: number;
    /** Use calibration/ good-vs-slop references to anchor taste. */
    useCalibration: boolean;
  };

  pivot: {
    /** Discard & restart an item from scratch if it stays below `threshold` on the
     *  SAME criterion for `N` consecutive rounds (GAN-style). */
    N: number;
    threshold: number;
  };

  contract: {
    /** Force this many concrete, individually-checkable assertions. */
    assertionMin: number;
    assertionMax: number;
    /** Max gen↔eval ping-pong rounds before forcing convergence. */
    maxNegotiationRounds: number;
  };

  build: {
    /** Max generate→evaluate rounds per work item before giving up the item. */
    maxRoundsPerItem: number;
    /** Per-SDK-session turn cap; sessions that hit it are resumed. */
    maxTurnsPerSession: number;
    /**
     * Per-item cumulative USD budget guard. The loop "starts closed": when an
     * item's accumulated cost crosses this cap it halts as BUDGET_EXCEEDED and the
     * run moves on to the next item. Set to 0 to explicitly opt out (no cap).
     */
    maxBudgetUsdPerItem: number;
  };

  format: {
    /**
     * Run a formatter/linter on each file the generator writes (a PostToolUse hook),
     * so formatting problems are fixed BEFORE the evaluator exercises the artifact and
     * never cost an evaluator round. A missing formatter is a no-op + warning, never a
     * build failure.
     */
    enabled: boolean;
    /**
     * Explicit formatter command. Use the `{file}` placeholder for the touched path
     * (e.g. "prettier --write {file}"). Empty → auto-detect (see `autodetect`).
     */
    command: string;
    /**
     * Auto-detect the formatter when `command` is empty: greenfield defaults to a
     * prettier-style formatter by file type; existing repos detect from CODEBASE_MAP.md
     * (e.g. swiftformat/swiftlint for iOS).
     */
    autodetect: boolean;
  };

  exercise: {
    /** How the evaluator actually EXERCISES the artifact (not a diff reader). */
    mechanism: ExerciseMechanism;
    /** On existing projects, also run the repo's own test suite; new failures = hard fail. */
    runExistingTests: boolean;
    /** Command Sparra runs to detect/run the existing suite (auto-detected if empty). */
    existingTestCommand: string;
    /** For mechanism: custom — a shell recipe the evaluator may invoke. */
    customRecipe: string;
    /** For mechanism: web — base URL / start command. */
    web: { startCommand: string; baseUrl: string };
    /** For mechanism: ios — simulator + scheme hints. */
    ios: { scheme: string; simulator: string };
  };

  deviation: {
    /**
     * strict   → no deviation beyond the literal contract.
     * moderate → may improve within the current item's scope; out-of-scope → proposal.
     * free     → may depart from the plan when it genuinely improves the product.
     * (Defaults are set by mode: greenfield→free, existing→moderate.)
     */
    strictness: DeviationStrictness;
  };

  batch: { K: number };
}

function role(model: ModelRef, effort?: RoleConfig["effort"]): RoleConfig {
  return effort ? { model, effort } : { model };
}

/** Defaults are deliberately conservative and safe. */
export function defaultConfig(): SparraConfig {
  return {
    roles: {
      orienter: role("sonnet", "high"),
      planner: role("opus", "high"),
      prototyper: role("sonnet", "medium"),
      contractGenerator: role("sonnet", "high"),
      contractEvaluator: role("opus", "high"),
      generator: role("sonnet", "high"),
      evaluator: role("opus", "high"),
      reflector: role("opus", "high"),
    },
    permission: {
      mode: "auto",
      denyBashContains: ["rm -rf /", "git push", "shutdown", "mkfs", ":(){", "curl | sh", "sudo "],
    },
    git: { strategy: "worktree", branchPrefix: "sparra/", autoCommit: false },
    rubric: {
      weights: { design: 0.25, originality: 0.15, craft: 0.3, functionality: 0.3 },
      passThreshold: 75,
      useCalibration: true,
    },
    pivot: { N: 3, threshold: 50 },
    contract: { assertionMin: 15, assertionMax: 30, maxNegotiationRounds: 4 },
    // Start closed: a real per-item budget by default; set to 0 to opt out (no cap).
    build: { maxRoundsPerItem: 6, maxTurnsPerSession: 60, maxBudgetUsdPerItem: 5 },
    format: { enabled: true, command: "", autodetect: true },
    exercise: {
      mechanism: "cli",
      runExistingTests: true,
      existingTestCommand: "",
      customRecipe: "",
      web: { startCommand: "", baseUrl: "http://localhost:3000" },
      ios: { scheme: "", simulator: "iPhone 15" },
    },
    deviation: { strictness: "moderate" },
    batch: { K: 3 },
  };
}

/** Deep-merge a partial parsed-YAML object over defaults (objects merge, scalars/arrays replace). */
export function deepMerge<T>(base: T, over: unknown): T {
  if (over == null || typeof over !== "object" || Array.isArray(over)) {
    return (over ?? base) as T;
  }
  if (base == null || typeof base !== "object" || Array.isArray(base)) {
    return over as T;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    out[k] = deepMerge((base as Record<string, unknown>)[k], v);
  }
  return out as T;
}

export async function loadConfig(paths: Paths): Promise<SparraConfig> {
  const def = defaultConfig();
  if (!exists(paths.config)) return def;
  const raw = await readText(paths.config);
  if (!raw) return def;
  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch (e) {
    throw new Error(`Could not parse ${paths.config}: ${(e as Error).message}`);
  }
  return deepMerge(def, parsed);
}

export async function writeDefaultConfig(paths: Paths, mode: "greenfield" | "existing"): Promise<void> {
  if (exists(paths.config)) return;
  const cfg = defaultConfig();
  // Deviation default depends on mode.
  cfg.deviation.strictness = mode === "greenfield" ? "free" : "moderate";
  const header = `# Sparra configuration — every knob lives here.
# Models accept SDK aliases: opus | sonnet | haiku | fable (or a full model id).
# Detected mode: ${mode}.  Edit and re-run any phase; changes are picked up live.
`;
  await writeText(paths.config, header + "\n" + YAML.stringify(cfg));
}
