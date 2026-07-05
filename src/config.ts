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
  /**
   * QUALITY-triggered escalation for a GENERATOR role (same shape as `fallback`, one level) —
   * distinct from `fallback`, which is LIMIT-triggered. When `build.escalateAfterRounds` > 0
   * and an item accumulates that many FAILED rounds, the build loop switches the item's
   * generator to this (stronger) role for its remaining rounds: per-item (the next item starts
   * back on the primary), one-way (no de-escalation), new session on the switch. Blocked
   * (inconclusive) and limit-retried rounds don't count toward the threshold. The escalated
   * role's own `fallback` chain still applies when its backend hits a provider limit.
   */
  escalation?: RoleConfig;
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
    /**
     * Auto-provision the repo's dependency dirs into the build/eval worktree so the generator's
     * verify commands and the evaluator's `npm test` can run there (a bare `git worktree` has no
     * `node_modules`). Gated to the worktree boundary (no-op in place), skippable, and a no-op when
     * the dir already exists in the worktree. Dirs are COPIED (copy-on-write where supported), never
     * symlinked — an outside-pointing link would break the workspace-write scratch sandbox.
     *   enabled → default true; set false to skip provisioning (e.g. you provision deps yourself).
     *   dirs    → which top-level dirs to copy; default ["node_modules"].
     */
    provisionDeps: { enabled: boolean; dirs: string[] };
  };

  rubric: {
    /** Weights need not sum to 1; they are normalized at scoring time. */
    weights: { design: number; originality: number; craft: number; functionality: number };
    /** 0..100. An item round must reach this weighted score to pass. */
    passThreshold: number;
    /** Use calibration/ good-vs-slop references to anchor taste. */
    useCalibration: boolean;
    /** Cap the functionality score at round(100 × passed/total) when any contract assertion
     *  FAILED — a conservative ceiling only (never a boost), so functionality can't contradict
     *  the assertion outcomes. No assertions listed → no cap. */
    anchorFunctionality: boolean;
  };

  pivot: {
    /** Discard & restart an item from scratch if it stays below `threshold` on the
     *  SAME criterion for `N` consecutive rounds (GAN-style). */
    N: number;
    threshold: number;
    /**
     * On a pivot, also RESET the workspace to the item-start state (revert tracked changes +
     * remove non-ignored untracked files; gitignored scratch survives — `clean` without `-x`)
     * so the fresh generator can't re-anchor on the failed attempt's files. Default true, but
     * INERT unless an exact Sparra-owned anchor holds at reset time: `git.autoCommit` on
     * (HEAD == item-start), a recorded Sparra branch, and the workspace's live git state
     * matching it (see src/build/reset.ts). In-place runs never reset.
     */
    resetWorkspace: boolean;
  };

  contract: {
    /** Force this many concrete, individually-checkable assertions. */
    assertionMin: number;
    assertionMax: number;
    /** Max gen↔eval ping-pong rounds before forcing convergence. */
    maxNegotiationRounds: number;
    /**
     * Harness verify-PROBE (no model): on CONTRACT: AGREED, dry-run each command in the
     * contract's "I will verify by" section (safe executor, cwd=workspace). A USAGE error
     * (command not found / unknown flag / usage text) or an UNSAFE command (rejected by the
     * safety rules — the harness can never run it) bounces the contract back into
     * negotiation with the probe output; an expected BEHAVIORAL failure (artifact not built
     * yet) does not. Default true; false skips the probe.
     */
    probeVerifyCommands: boolean;
  };

  build: {
    /** Max work items a decomposition may produce; more are clamped (head kept) with a
     *  warning. The prompt already asks for a coarse split — this is the code-side guard
     *  against a runaway decomposition multiplying contract/build cost. 0 = no cap. */
    maxItems: number;
    /** On an unparseable generator report / evaluator verdict JSON, re-ask ONCE (resuming the
     *  same session: "re-emit ONLY the JSON block") before the existing fallback (degraded
     *  report / forced FAIL). Skipped when the item budget is already exhausted. */
    jsonReask: boolean;
    /** Max generate→evaluate rounds per work item before giving up the item. */
    maxRoundsPerItem: number;
    /** Per-SDK-session turn cap; sessions that hit it are resumed. */
    maxTurnsPerSession: number;
    /**
     * Quality-escalation threshold: after this many FAILED rounds on one item, switch that
     * item's generator to its configured `roles.<generator>.escalation` role for the remaining
     * rounds (see RoleConfig.escalation — quality-triggered, vs the limit-triggered `fallback`).
     * Blocked rounds and limit-retried rounds don't count. 0 (default) = off; escalation also
     * requires the generator role to carry an `escalation`.
     */
    escalateAfterRounds: number;
    /**
     * Per-ASSERTION escalation threshold (K). Once the SAME contract assertion FAILS this many
     * consecutive evaluated rounds, its next patch feedback ESCALATES: the harness uncaps that
     * assertion's evidence (no per-assertion cap) and prepends a diagnose-first instruction naming
     * the id ("state the root cause of #N before editing"). Other assertions stay capped. A register
     * between a plain patch and a full GAN pivot — it does not touch the pivot/blocked/un-run/review
     * branches. Blocked and all-un-run rounds don't advance assertion streaks; a pivot resets them.
     * Default 2; 0 disables escalation (feedback stays the normal patch feedback).
     */
    assertionEscalateAfter: number;
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
     * Fallback TOKEN ceiling used only when the USD cap is active, reported cost stays
     * zero/unknown, and `maxTokensPerItem` is off. Same convention: 0 = no fallback cap.
     */
    zeroCostTokenCap: number;
    /**
     * Environment variables injected into build execution surfaces: agent SDK sessions,
     * evaluator exercise commands, and harness verify/measure commands. Values must be strings.
     * The runner merges these over process.env before passing env to SDKs/spawns because the SDKs
     * replace inherited env whenever env is provided.
     */
    env: Record<string, string>;
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
    /**
     * Verification commands the GENERATOR may self-run (auto-approved) before finishing, so it
     * stops "writing blind" — typecheck/test/build. A Bash command is auto-approved only when it
     * starts with one of these AND contains no command-chaining/redirect/network/mutation/commit
     * (so `npm test`/`tsc --noEmit` run, but `npm test && rm -rf x`, `curl …`, `git commit` do
     * not). Auto-approval is GATED to a git worktree/branch boundary (the same wall as Codex
     * full-access), OR to an in-place `run_role` that opts in via `allowVerify` / `--verify`.
     * Codex confines these to its workspace-write sandbox
     * (no network); Claude has no OS sandbox, so for Claude these run with the worktree + "never
     * commit to main" + the disqualifier list as the only guarantees (like the evaluator's
     * exercise). Set to `[]` to disable generator self-verification. These prefixes are ALSO
     * the explicit opt-in past the harness executor's argv[0] allowlist AND its subcommand
     * safety (contract verify-probe + flakiness rerun gate, src/build/exec.ts): unknown tools
     * are rejected by default, and package managers run only as test / run <script> /
     * run-script <script> (npm version, cargo publish, … are unsafe) — declaring a command
     * here lets the harness run it.
     */
    verifyCommands: string[];
    /**
     * Flakiness RERUN gate (no model): after a PASSING verdict, the harness re-runs the
     * contract's verify commands this many times. ANY non-ok result demotes the pass to a
     * failed round with the command + output as blocking feedback — mixed exits = FLAKY,
     * deterministic nonzero = failing-as-shipped, UNSAFE (safety-rule-rejected, never ran)
     * demotes the same way; only all-runs-exit-0 keeps the pass. Default 2; 0 = off.
     */
    flakinessReruns: number;
    /**
     * Pre-evaluator PREFLIGHT gate (no model): after each generation and BEFORE the adversarial
     * evaluator, run the contract's OWN "I will verify by" commands once via the safe executor.
     * On a deterministic BEHAVIORAL failure (a command ran, exited nonzero, and is not a broken/
     * usage or unsafe command) the round SKIPS the evaluator and bounces straight back to the
     * generator with the (holdout-redacted) command output — so a generation that fails its own
     * gates never costs a full evaluator session. Capped at ONE bounce before an evaluator round
     * must run (so preflight can never loop the item without the evaluator weighing in). usage/
     * unsafe/all-green outcomes fall through to the evaluator unchanged. Off by default — with the
     * knob unset a round makes zero preflight executor calls and evaluates exactly as today.
     */
    preflightVerify: boolean;
    /**
     * On item terminal (pass or fail) distill ONE transferable TECHNIQUE — what FIXED (or was tried
     * on) the item — from the item's durable round history and append it to memory.md as a marked,
     * holdout-redacted `note` learning, within the existing memory caps. Deterministic (no model
     * call), never the score/bookkeeping, once per item across resume. Off by default — with the
     * knob unset memory content is exactly as today (no extra note appended). See
     * `memory.distillTechnique` / docs/build-loop.md.
     */
    distillTechnique: boolean;
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

  /**
   * Post-accept MEASURE step (opt-in). After an item is accepted, run the project's OWN
   * measurement/QA harness, parse structured metrics, diff them against a stored baseline, and
   * flag regressions. NON-BLOCKING by design: measure is a *signal* — it records an artifact +
   * a memory line and feeds reflect, but NEVER blocks the commit or reopens the item. Also a
   * standalone `sparra measure [dir]`. See docs/build-loop.md for the metric-emission contract.
   */
  measure: {
    /** Off by default; a config-less run is unaffected. */
    enabled: boolean;
    /**
     * The measurement command Sparra runs. Executed via the SAME no-shell, argv-tokenized safe
     * executor as `build.verifyCommands` (its own value is the explicit opt-in past the argv[0]
     * allowlist), so it must be a SINGLE argv command (e.g. `npm run qa:metrics`), NOT a pipe or
     * `&&`-chain. It prints a JSON object with a `metrics` field on stdout (see build-loop.md).
     */
    command: string;
    /** Baseline JSON path (relative to the repo root). Empty → `<.sparra>/measure/baseline.json`.
     *  Always read/written from the MAIN repo `.sparra` so it survives an isolated worktree build. */
    baselineFile: string;
    /** A metric is flagged regressed when it worsens (per its goal direction) by MORE than this
     *  fraction of the baseline (default 0.05 = 5%). A change within ±threshold is not a regression. */
    regressionThreshold: number;
    /** Goal direction for a bare-number metric with no explicit `goal` ("min" = lower is better). */
    defaultGoal: "min" | "max";
  };

  exercise: {
    /** How the evaluator actually EXERCISES the artifact (not a diff reader). */
    mechanism: ExerciseMechanism;
    /** On existing projects, also run the repo's own test suite; new failures = hard fail. */
    runExistingTests: boolean;
    /** Observed-run gate: demote a PASS verdict to FAIL when the harness observed ZERO
     *  mcp__exercise__ activity (`exerciseStatus() === "none"`) — an unobserved pass rests on
     *  pure self-report. Applies to mechanisms `cli` and `web`, where run_command/http_request
     *  ARE the exercise path; `ios`/`computer-use`/`custom` are exempt (exercising there
     *  legitimately flows through tools the classifier can't see). `false` opts out. */
    requireObservedRun: boolean;
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
     *   visual    (iOS only, default true) inject the VISUAL-VERIFICATION recipe into the
     *             evaluator guidance: capture a Simulator screenshot AND — for animations —
     *             a `recordVideo`→ffmpeg contact sheet the multimodal evaluator READS, plus
     *             the `#if DEBUG` launch-arg deterministic-reach convention and the honest
     *             statement of what the Simulator can/can't prove. Off → the pre-recipe
     *             iOS guidance (byte-identical to before the knob existed).
     */
    ios: { cli: string; scheme: string; simulator: string; platform: "ios" | "macos"; visual: boolean };
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
    git: {
      strategy: "worktree",
      branchPrefix: "sparra/",
      autoCommit: false,
      agentCommits: "agent",
      provisionDeps: { enabled: true, dirs: ["node_modules"] },
    },
    rubric: {
      weights: { design: 0.25, originality: 0.15, craft: 0.3, functionality: 0.3 },
      passThreshold: 75,
      useCalibration: true,
      anchorFunctionality: true,
    },
    pivot: { N: 3, threshold: 50, resetWorkspace: true },
    // Range is an upper guide, scaled down per item — small items use far fewer.
    // maxNegotiationRounds 6: meaty items (foundational data models, etc.) often still have
    // genuine evaluator objections open at 4 → force-agree with real gaps. Contract rounds are
    // cheap text (no build); 6 lets the negotiation actually converge before the expensive build.
    contract: { assertionMin: 6, assertionMax: 20, maxNegotiationRounds: 6, probeVerifyCommands: true },
    // Start closed: a real per-item USD budget by default; set to 0 to opt out.
    // maxTokensPerItem defaults to off (the USD cap is the default bound); set it
    // for a direct token ceiling, which is the meaningful lever on a subscription.
    build: {
      maxItems: 12,
      jsonReask: true,
      maxRoundsPerItem: 6,
      maxTurnsPerSession: 60,
      // Quality escalation is off by default; pair a >0 value with roles.generator.escalation.
      escalateAfterRounds: 0,
      // Per-assertion feedback escalation after K consecutive same-assertion fails (0 disables).
      assertionEscalateAfter: 2,
      maxBudgetUsdPerItem: 5,
      maxTokensPerItem: 0,
      zeroCostTokenCap: 0,
      // Off by default: opting in lets an unattended build sleep for hours waiting out a limit.
      autoRestart: { enabled: false, maxWaitSec: 21600, pollSec: 300, maxRestarts: 20 },
      env: {},
      skills: [],
      extraReadDirs: [],
      // Default set deliberately EXCLUDES package-runners like `npx` that fetch/install on demand —
      // they'd open a network/install path on a backend without an OS sandbox (Claude). Use the
      // project's own scripts (`npm run …`) or locally-installed binaries; add others per project.
      verifyCommands: [
        "npm test", "npm run test", "npm run typecheck", "npm run build", "npm run lint", "npm run check",
        "tsc", "vitest", "pnpm test", "yarn test",
        "swift build", "swift test", "pytest", "python -m pytest",
        "cargo build", "cargo test", "cargo check", "go build", "go test", "go vet",
        "make test", "make build", "make check",
      ],
      flakinessReruns: 2,
      // Off by default: opting in bounces a generation that fails its own verify commands
      // straight back to the generator, skipping (and saving) an evaluator session that round.
      preflightVerify: false,
      // Off by default: opting in appends one distilled, transferable technique note per item terminal.
      distillTechnique: false,
    },
    format: { enabled: true, command: "", autodetect: true },
    // Off by default: measure runs the project's OWN QA harness after accept (signal, non-blocking).
    measure: { enabled: false, command: "", baselineFile: "", regressionThreshold: 0.05, defaultGoal: "min" },
    exercise: {
      mechanism: "cli",
      runExistingTests: true,
      requireObservedRun: true,
      sandbox: "workspace-write",
      existingTestCommand: "",
      customRecipe: "",
      web: { startCommand: "", baseUrl: "http://localhost:3000" },
      ios: { cli: "xcodebuildmcp", scheme: "", simulator: "", platform: "ios", visual: true }, // simulator: "" → auto-discover; platform: "macos" for a Mac app; visual: true → screenshot+animation recipe
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
  validateBuildEnv(parsed, paths.config);
  return deepMerge(def, parsed);
}

function validateBuildEnv(parsed: unknown, configPath: string): void {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
  const build = (parsed as Record<string, unknown>).build;
  if (build == null) return;
  if (typeof build !== "object" || Array.isArray(build)) return;
  const env = (build as Record<string, unknown>).env;
  if (env == null) return;
  if (typeof env !== "object" || Array.isArray(env)) {
    throw new Error(`Invalid ${configPath}: build.env must be a map of string values`);
  }
  for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
    if (typeof value !== "string") {
      throw new Error(`Invalid ${configPath}: build.env.${key} must be a string`);
    }
  }
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
