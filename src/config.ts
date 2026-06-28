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
  /**
   * Native OS-sandbox scope for a WRITE role on a backend that has one (Codex today; Claude
   * ignores it). Unset → "workspace-write" (the default — writes scoped to the work tree, no
   * network). "danger-full-access" lifts the sandbox so a Codex generator can run native
   * toolchains the default Seatbelt profile blocks (e.g. `xcodebuild`). Read-only roles ignore
   * this (they are always read-only). "danger-full-access" is honored ONLY when the build runs
   * on a git worktree/branch boundary; on an in-place/greenfield-no-git run it is downgraded to
   * "workspace-write" with a loud warning (the worktree is the only safety boundary).
   */
  sandbox?: "workspace-write" | "danger-full-access";
  /**
   * Fallback model for this role, used when the primary's BACKEND is in a provider limit
   * window (requires `build.autoRestart.enabled`). On a limit the loop switches to this
   * model — ideally on a DIFFERENT backend (e.g. primary gpt-5.5 on codex → fallback opus
   * on claude) — and continues immediately instead of sleeping, switching back once the
   * primary's window reopens. Chainable (a fallback may have its own `fallback`); a fallback
   * on the same, also-limited backend is skipped. Unset → the loop waits out the window.
   */
  fallback?: RoleConfig;
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
    /** Authors the conventional commit(s) for an accepted item (when `git.agentCommits`).
     *  A small, well-bounded task — defaults to a cheap model. Read-only: it emits a commit
     *  PLAN; the harness executes it. */
    committer: RoleConfig;
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
     * When true, commit each accepted item — but ONLY onto the Sparra-created worktree/branch
     * (never your main branch, never an in-place tree). Default false.
     */
    autoCommit: boolean;
    /**
     * How the commit(s) are authored when `autoCommit` is on:
     *   agent    → the `committer` role reads the diff and proposes one or more atomic
     *              Conventional-Commits (split by logical change); the harness executes the
     *              plan and appends a `Sparra-Item` trailer. Falls back to `template` on
     *              failure. (default)
     *   template → one deterministic commit per item from the item's title/summary (no model).
     */
    agentCommits: "agent" | "template";
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
    /**
     * Auto-restart on a provider rate/usage/session limit. When the generator or evaluator
     * hits a real provider limit (vs. our own per-item caps), the loop WAITS for the window
     * to reopen and retries the same round instead of burning it. The "heartbeat" that lets
     * an unattended build survive a subscription window closing.
     *   enabled     off by default (opt-in; an unattended build can then sleep for hours).
     *   maxWaitSec  cap on a SINGLE wait. Default 21600 (6h) — long enough to wait out a
     *               Claude 5-hour plan window in one sleep. A longer window → wait the cap,
     *               retry, and (if still limited) wait again, counting against maxRestarts.
     *   pollSec     when the backend gives no reset time (e.g. Codex), recheck cadence.
     *   maxRestarts total wait cycles per run before giving up and stopping (resumable: just
     *               re-run `sparra build`). The hard stop so a stuck limit can't loop forever.
     */
    autoRestart: {
      enabled: boolean;
      maxWaitSec: number;
      pollSec: number;
      maxRestarts: number;
    };
    /**
     * Extra directories the build may READ beyond the work dir (+ repo root) — added to the
     * generator's and evaluator's `additionalDirectories`. For large assets you don't want in
     * git: pre-stage them once (e.g. a face-recognition model in `~/.cache/…`) and list the dir
     * here so the sandboxed build can read it without committing it or opening network. Paths may
     * be absolute, `~`-prefixed, or relative to the repo root. (Codex grants read+write to these
     * within its sandbox; Claude read with writes still gated — treat as read-only intent.)
     */
    extraReadDirs: string[];
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
    /** Sandbox the evaluator's EXERCISE runs under on a backend with a native OS sandbox (Codex).
     *  "workspace-write" (default) lets the exercise write the scratch that test/build tools need
     *  (e.g. node_modules/.vite-temp, tsc/test caches) so `npm test`/`tsc` actually run; a
     *  runner-level source-integrity guard reverts + FAILS any write the evaluator makes to the
     *  artifact surface, and network stays off — so the evaluator still cannot mutate the code it
     *  grades or reach the network. "read-only" forces Codex's strict no-write sandbox (the pre-fix
     *  behavior; exercising tools that need scratch will EPERM). Only relaxed on a worktree/branch
     *  boundary (the integrity guard needs git to revert); in-place runs stay read-only. The Claude
     *  evaluator exercises via the in-process runner regardless of this. */
    sandbox: "read-only" | "workspace-write";
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
     *   simulator the simulator name (e.g. "iPhone 16"). (iOS only.)
     *   platform  "ios" (Simulator: simctl/ui-automation screenshots) or "macos" (no
     *             simulator — build & run the .app on the host; UI is observed/driven via an
     *             XCUITest target run with `macos test` + xcresult screenshots, plus
     *             screencapture). Default "ios".
     */
    ios: { cli: string; scheme: string; simulator: string; platform: "ios" | "macos" };
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
  /**
   * Subfolder (relative to the project root) for the human-facing docs Sparra
   * manages — PLAN.md, CODEBASE_MAP.md, CHANGELOG.md, HOLDOUT.md. "" keeps them
   * at the root (default); e.g. "docs" puts them under docs/. Set at
   * `sparra init --docs <dir>`. (.sparra/ machinery is unaffected.)
   */
  docsDir: string;
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
      committer: role("haiku", "low"),
      reflector: role("opus", "high"),
    },
    permission: {
      mode: "auto",
      denyBashContains: ["rm -rf /", "git push", "shutdown", "mkfs", ":(){", "curl | sh", "sudo "],
    },
    git: { strategy: "worktree", branchPrefix: "sparra/", autoCommit: false, agentCommits: "agent" },
    rubric: {
      weights: { design: 0.25, originality: 0.15, craft: 0.3, functionality: 0.3 },
      passThreshold: 75,
      useCalibration: true,
    },
    pivot: { N: 3, threshold: 50 },
    // Range is an upper guide, scaled down per item — small items use far fewer.
    // maxNegotiationRounds 6: meaty items (foundational data models, etc.) often still have
    // genuine evaluator objections open at 4 → force-agree with real gaps. Contract rounds are
    // cheap text (no build); 6 lets the negotiation actually converge before the expensive build.
    contract: { assertionMin: 6, assertionMax: 20, maxNegotiationRounds: 6 },
    // Start closed: a real per-item USD budget by default; set to 0 to opt out.
    // maxTokensPerItem defaults to off (the USD cap is the default bound); set it
    // for a direct token ceiling, which is the meaningful lever on a subscription.
    build: {
      maxRoundsPerItem: 6,
      maxTurnsPerSession: 60,
      maxBudgetUsdPerItem: 5,
      maxTokensPerItem: 0,
      // Off by default: opting in lets an unattended build sleep for hours waiting out a limit.
      autoRestart: { enabled: false, maxWaitSec: 21600, pollSec: 300, maxRestarts: 20 },
      skills: [],
      extraReadDirs: [],
    },
    format: { enabled: true, command: "", autodetect: true },
    exercise: {
      mechanism: "cli",
      runExistingTests: true,
      sandbox: "workspace-write",
      existingTestCommand: "",
      customRecipe: "",
      web: { startCommand: "", baseUrl: "http://localhost:3000" },
      ios: { cli: "xcodebuildmcp", scheme: "", simulator: "", platform: "ios" }, // simulator: "" → auto-discover; platform: "macos" for a Mac app
    },
    deviation: { strictness: "moderate" },
    review: { enabled: false, blockOn: "high" },
    batch: { K: 3 },
    docsDir: "",
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

export async function writeDefaultConfig(
  paths: Paths,
  mode: "greenfield" | "existing",
  docsDir = ""
): Promise<void> {
  if (exists(paths.config)) return;
  const cfg = defaultConfig();
  // Deviation default depends on mode.
  cfg.deviation.strictness = mode === "greenfield" ? "free" : "moderate";
  cfg.docsDir = docsDir;
  const header = `# Sparra configuration — every knob lives here.
# Models accept SDK aliases: opus | sonnet | haiku | fable (or a full model id).
# Detected mode: ${mode}.  Edit and re-run any phase; changes are picked up live.
`;
  await writeText(paths.config, header + "\n" + YAML.stringify(cfg));
}
