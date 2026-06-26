import YAML from "yaml";
import { readText, writeText, exists } from "./util/io.ts";
import type { Paths } from "./paths.ts";

/** Model alias accepted by the SDK ('opus' | 'sonnet' | 'haiku' | 'fable') or a full model id. */
export type ModelRef = string;

export interface RoleConfig {
  /** Which agent backend runs this role ("claude" default, "codex", …). */
  backend?: string;
  model: ModelRef;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /**
   * Point this role at an OpenAI-compatible endpoint instead of the backend's default —
   * e.g. a LOCAL model served by LM Studio (`http://localhost:1234/v1`) or Ollama. Only the
   * `codex` backend honors this today (it supplies the agent loop + tools; the model is local).
   * `model` is then the local model id; `apiKey` is usually a dummy ("lm-studio").
   */
  baseUrl?: string;
  apiKey?: string;
  /**
   * Agent skills to make available to this role. Overrides `build.skills`. Builder roles
   * (generator, prototyper) inherit `build.skills` when this is unset; other roles get
   * skills only when listed here. Names match a SKILL.md `name`/dir, or an explicit path.
   */
  skills?: string[];
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
    /** Breaks the frozen plan into work items — a planning/judgment act, not a build act. */
    decomposer: RoleConfig;
    prototyper: RoleConfig;
    contractGenerator: RoleConfig;
    contractEvaluator: RoleConfig;
    generator: RoleConfig;
    /**
     * Optional second generator for items tagged `gen: "local"` (hybrid builds) — e.g. a local
     * LM Studio model for trivially-simple or privacy-sensitive items, keeping the main
     * `generator` (e.g. a cloud model) for the hard ones. Unset → all items use `generator`.
     */
    generatorLocal?: RoleConfig;
    evaluator: RoleConfig;
    /** Independent code review of the generated diff/source (opt-in via `review`). */
    reviewer: RoleConfig;
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
    /**
     * When true, commit each accepted item as one conventional commit — but ONLY onto the
     * Sparra-created worktree/branch (never your main branch, never an in-place tree).
     * Default false.
     */
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
     *
     * NOTE: total_cost_usd is a notional figure (tokens × list price). On a
     * subscription you're billed in tokens against rate limits, not USD, so this
     * cap is a proxy — use `maxTokensPerItem` for a direct token bound.
     */
    maxBudgetUsdPerItem: number;
    /**
     * Per-item cumulative TOKEN budget guard (input+output+cache, summed across
     * models). The direct lever for subscription accounts. Same semantics as the
     * USD cap: crossing it halts the item as BUDGET_EXCEEDED. 0 = no cap.
     */
    maxTokensPerItem: number;
    /**
     * Agent skills made available to the builder roles (generator, prototyper) by default.
     * Claude loads them natively (as a scoped local plugin, settingSources stays []); Codex
     * gets their SKILL.md inlined into the input. Per-role `roles.<role>.skills` overrides.
     */
    skills: string[];
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
    /**
     * For mechanism: ios — Apple-platform build/run/UI-automation.
     *   cli       the executable to drive (default "xcodebuildmcp"; preferred over
     *             raw xcodebuild/xcrun/simctl). Empty → use raw Apple tooling.
     *   scheme    the Xcode scheme to build/run.
     *   simulator the simulator name (e.g. "iPhone 16").
     */
    ios: { cli: string; scheme: string; simulator: string };
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

  /**
   * Optional agent CODE REVIEW gate, run on the diff/source after an item passes the
   * behavioral evaluator. A second, independent lens (best on a different backend than the
   * generator) for code quality the exerciser can't see — dead code, security, structure,
   * convention conformance. Off by default; it costs another role per item.
   */
  review: {
    enabled: boolean;
    /** Which finding severities block acceptance: "high" (blocking-severity only) |
     *  "all" (advisory too) | "none" (purely advisory — never blocks). */
    blockOn: "high" | "all" | "none";
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
      decomposer: role("sonnet", "high"),
      prototyper: role("sonnet", "medium"),
      contractGenerator: role("sonnet", "high"),
      contractEvaluator: role("opus", "high"),
      generator: role("sonnet", "high"),
      evaluator: role("opus", "high"),
      reviewer: role("opus", "high"),
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
    // Range is an upper guide, scaled down per item — small items use far fewer.
    contract: { assertionMin: 6, assertionMax: 20, maxNegotiationRounds: 4 },
    // Start closed: a real per-item USD budget by default; set to 0 to opt out.
    // maxTokensPerItem defaults to off (the USD cap is the default bound); set it
    // for a direct token ceiling, which is the meaningful lever on a subscription.
    build: { maxRoundsPerItem: 6, maxTurnsPerSession: 60, maxBudgetUsdPerItem: 5, maxTokensPerItem: 0, skills: [] },
    format: { enabled: true, command: "", autodetect: true },
    exercise: {
      mechanism: "cli",
      runExistingTests: true,
      existingTestCommand: "",
      customRecipe: "",
      web: { startCommand: "", baseUrl: "http://localhost:3000" },
      ios: { cli: "xcodebuildmcp", scheme: "", simulator: "" }, // simulator: "" → auto-discover an available one
    },
    deviation: { strictness: "moderate" },
    review: { enabled: false, blockOn: "high" },
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
