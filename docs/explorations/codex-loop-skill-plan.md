# Codex-native interactive Sparra loop plan

## Goal

Make Sparra's interactive loop usable from a Codex session with the same practical capabilities available in Claude Code today:

- initialize or reuse a project configuration;
- negotiate an adversarial, checkable contract;
- run generator, evaluator, reviewer, and contract roles through `run_role`;
- choose Claude or Codex independently for every role;
- preserve the holdout wall and return only holdout-redacted evaluator evidence;
- isolate long role runs from the conductor's context;
- schedule independent units concurrently without workspace collisions;
- recover correctly from provider limits, turn/budget caps, empty completions, and collapsed cross-model evaluation;
- run the full `sparra build --step` workflow when ad-hoc choreography is the wrong level;
- install and invoke the workflow naturally from Codex.

"Equivalent" means equivalent loop behavior and safety, not identical host-specific commands. Claude Code keeps its Task tool and packaged `sparra-role` agent. Codex uses background Sparra CLI processes today, may use native delegated workers when that capability exists, and retains blocking direct MCP only as a last resort.

## Current state

The repository has a mature Claude-oriented implementation:

- `skills/sparra-loop/SKILL.md` contains the conductor workflow;
- `agents/sparra-role.md` is a Claude worker that invokes one role and returns a summary;
- `.claude-plugin/marketplace.json` packages both Sparra skills and the worker;
- `sparra-run-mcp` exposes `run_role` and `remove_unit_worktree` over stdio MCP;
- `sparra role run` and `sparra eval` provide a CLI fallback.

There is no Codex plugin manifest or Codex-specific installation path yet. The current loop skill also embeds Claude-specific assumptions (`Task`, `run_in_background`, the packaged worker agent, and Claude MCP inheritance) directly in otherwise platform-neutral loop rules.

The existing Claude worker summary contract is narrower than the conductor's decision logic. It does not explicitly require all control fields needed to distinguish a behavioral failure from limits, partial landed work, resumable sessions, or a collapsed cross-model gate. Fixing that is part of the shared work, not only the Codex port.

## Design principles

1. **One loop specification, thin host adapters.** Keep contract/evaluate/decide semantics in one shared source. Isolate Claude and Codex invocation details so they cannot drift into two copies of the loop.
2. **The runner remains the security boundary.** The skill never reads holdout files. It passes holdout paths to Sparra, consumes only the redacted MCP/CLI payload, and never tails evaluator traces.
3. **Capability-driven orchestration.** Prefer native delegation when the host exposes it; otherwise use isolated background CLI processes, then blocking direct MCP. Correctness must not depend on subagents existing.
4. **Capacity-aware concurrency.** Parallelize only matrix-safe work. Claude retains its explicit all-runnable-in-one-message rule; Codex uses a conservative launch/refill queue over background processes until it has queryable worker capacity.
5. **A typed result envelope.** Every worker/direct invocation returns the same concise, decision-relevant fields. The conductor should not infer state from prose.
6. **CLI parity is an adapter contract.** MCP and JSON CLI output share one runner-owned payload builder. Background CLI is Codex's current isolation/concurrency workhorse and remains the dogfooding path while the persistent MCP server is changing.
7. **Progressive disclosure.** Keep the triggered skill concise; load detailed recovery, scheduling, and command references only when relevant.

## Proposed repository shape

```text
.claude-plugin/
  marketplace.json                 # existing Claude packaging
.codex-plugin/
  plugin.json                      # new Codex packaging
  mcp.json                         # non-colliding Codex MCP declaration, if validated
agents/
  sparra-role.md                   # Claude adapter/worker
skills/
  sparra-loop/
    SKILL.md                       # shared conductor entry point + host selection
    references/
      loop-core.md                 # contract -> generate -> evaluate -> decide
      role-result.md               # canonical summary/result envelope
      scheduling.md                # safety matrix + capacity-aware scheduler
      recovery.md                  # limits, caps, resumes, empty completion
      interactive-build.md         # eval and build --step paths
      claude-code.md               # Task/background worker adapter
      codex.md                     # delegated/background-CLI/direct-MCP adapter
  sparra/
    SKILL.md                       # existing operational skill
    subskills/diagnose.md
docs/
  role-runner.md                   # Claude and Codex install/use instructions
```

Use the same `sparra-loop` skill name on both hosts. The shared `SKILL.md` detects the current host's available capabilities and loads only the matching adapter reference. Claude packaging continues to include `agents/sparra-role.md`; Codex packaging does not pretend that Claude agent manifests are portable.

## Canonical role-result envelope

Export a `RunRolePayload` type beside the pure `buildRunRolePayload` in `src/mcp/runRoleServer.ts`. Use that builder for MCP responses and for new `--json` output from both `sparra role run` and its `sparra eval` alias; do not duplicate the holdout split or scrape human logs. Name the current non-evaluator payload's `result` field `resultText` in this typed contract. `passThreshold` continues to come from rubric configuration through the builder.

This runner payload is the canonical envelope consumed by the Claude worker, Codex adapters, and conductor. All fields below must be copied verbatim from it. One Phase 1 addition is required first: `errors` exists on `RoleRunResult` but `buildRunRolePayload` currently emits it in neither branch, so the builder must add it to the MCP/CLI payload. `resultDigest` is the only worker-synthesized field and is optional; it may concisely index `resultText` but never replace control data.

```yaml
roleKind: generator | evaluator | reviewer | contract-generator | contract-evaluator
backend: string
model: string
sessionId: string?
ok: boolean
verdict: pass | fail | null
weightedTotal: number?
passThreshold: number?
blocking: string[]?
failedAssertions: object[]?
resultText: string?                # non-evaluator output, including a recovered generator report
resultDigest: string?              # optional; the only worker-synthesized field
verdictPath: string?
outPath: string?
traceDir: string?                 # never present/returned for evaluator
filesChanged: number?
sameModelGrade: boolean?
fallbackFrom: object?
limitHit: object?
hitBudget: boolean?
hitMaxTurns: boolean?
emptyCompletion: boolean?
noProgress: boolean?
verifyGateWarning: string?
unitWorktree: object?
promptDrift: object?
errors: string[]?
tokens: number?
costUsd: number?
```

After adding `errors` to the payload, the builder must preserve it together with `resultText` when one-shot report recovery succeeds: the recovered generator report is actionable even when `errors` records the recovery. It also carries `tokens` and `costUsd` so the conductor can manage budgets. The reference must describe which fields are holdout-safe, how each changes the next action, and that evaluator payloads omit `traceDir`; workers return no raw transcript, diff, evaluator trace, or holdout text.

## Codex orchestration adapter

Codex CLI 0.144.1 has no usable delegation surface: `enable_fanout` is under-development/off and `collaboration_modes` is removed. The adapter therefore implements three ordered, capability-gated modes.

### Future path: delegated role worker

When Codex collaboration tools are available and delegation is permitted:

1. Spawn one bounded worker per runnable role invocation.
2. Give it exactly one role, the exact `run_role` arguments, the holdout discipline, and the canonical result-envelope requirement.
3. Let the worker invoke the Sparra MCP tool; use the CLI fallback if the tool is unavailable.
4. Return only the canonical summary to the conductor.
5. Keep the conductor responsive while workers run and refill available slots as they complete.

This mode is enabled only when the running Codex host actually exposes delegation. It must not assume a fixed number of slots: query capacity if a stable surface exists, otherwise use the same conservative queue as the CLI mode.

### Current workhorse: background CLI processes

On current Codex, launch matrix-safe role calls as background shell processes using `sparra role run … --json --out <file>` (or `sparra eval … --json`). Capture each JSON envelope in an adapter-owned result file and read it only after completion; `--out` remains the caller-selected runner artifact. This provides both fresh-process context isolation and parallelism without importing role output into the conductor. Queue runnable calls conservatively and refill as processes finish because Codex exposes no queryable delegation capacity. The Codex adapter and `references/recovery.md` must resume `hitMaxTurns`, `hitBudget`, or landed `emptyCompletion` runs on either surface: MCP uses `resumeSessionId`/`resumeBackend`, while the CLI passes the same envelope values through `--resume-session <id>`/`--resume-backend <b>`.

The same mode must support teardown through `sparra role rm-worktree --name <name>`, including accept and abandon paths. Use the CLI while dogfooding runner changes so every process executes current code instead of a stale persistent server.

### Last resort: blocking direct MCP

If neither delegation nor background process execution is available, the conductor may call `run_role` directly. This loses context isolation, parallelism, and conductor responsiveness but not loop correctness or holdout safety because the server returns the redacted evaluator payload. Direct calls are allowed only after setup accounts for Codex's per-server `tool_timeout_sec` (60 seconds by default), since role calls routinely run for minutes. In this mode:

- do not request or expose raw role output;
- persist the canonical summary immediately;
- avoid importing verbose traces into the conductor;
- run sequentially and state that execution is blocking and capacity-limited.

### MCP discovery and CLI fallback

The Codex adapter should:

1. Detect both `run_role` and `remove_unit_worktree` capabilities without hard-coding their qualified names.
2. Prefer delegation when available; otherwise detect `sparra` on `PATH` and use background JSON CLI processes.
3. If shell processes are unavailable, use plugin-provided MCP only with a long-running tool timeout, or provide exact registration instructions including that setting.
4. Use `sparra role rm-worktree` whenever MCP `remove_unit_worktree` is unavailable.

Do not hard-code fully qualified runtime tool names in the shared core. Plugin namespaces and MCP exposure may alter the names Codex presents.

## Packaging and installation

### Codex plugin

Add and validate `.codex-plugin/plugin.json` with:

- a semver-plus-cachebuster version (for example `0.1.8-2841cf9749ae`);
- author, repository, homepage, license, and discovery metadata;
- `skills: "./skills/"`;
- `mcpServers: "./.codex-plugin/mcp.json"` only if that non-project-scoped declaration is validated;
- an `interface` block with display name, category, capabilities, default prompt, and icons, plus up to three starter prompts.

These shapes are verified in locally installed Codex plugins. Do not place unsupported Claude fields such as `agents` in the Codex manifest, and do not add a repository-root `.mcp.json`: Claude Code treats it as project MCP configuration and would prompt every Sparra development session to launch a stale persistent server.

### MCP declaration spike

Installed plugins verify that a plugin-root-relative declaration can start a self-contained stdio server with `command`, relative `args`, and `cwd: "."`. Sparra's current `bin/sparra-run-mcp.mjs` is not self-contained: it needs this package's `node_modules` for `tsx`, which the cached plugin snapshot does not carry. Therefore use the installed/linked `sparra-run-mcp` package bin on `PATH` (already exposed by `npm link`) as the expected default; bundling a server is a separate prerequisite for a plugin-snapshot-relative command.

Before locking the manifest, validate:

1. that `.codex-plugin/plugin.json` can point to `./.codex-plugin/mcp.json` without colliding with Claude project configuration;
2. that the declaration can invoke `sparra-run-mcp` from `PATH` after package install/link and retain the session workspace default plus explicit `--root` support;
3. whether the plugin declaration accepts `tool_timeout_sec` for multi-minute `run_role` calls; if not, omit or supplement it with exact Codex MCP registration instructions that set the timeout;
4. only if the server is bundled, that a plugin-root-relative command works from the installed cache snapshot.

Exercise a real long-running role call, not just initialization or tool discovery. A default 60-second timeout is a failure. This result decides whether blocking direct MCP remains usable at all and keeps it below the background CLI mode regardless.

### Marketplace/development loop

Use a personal local marketplace during dogfood, which the installed-plugin format supports, followed by a distributable marketplace after the adapter is stable. Use the Codex plugin cachebuster/reinstall workflow and start a new thread after reinstalling so changed skills and MCP tools are loaded. Keep Claude's existing marketplace version bump behavior independent from Codex's semver/cachebuster rules.

## Implementation phases

### Phase 0: Baseline the Claude behavior

- Copy the current skill's documented paths into durable prompts and objective assertions under `skills/sparra-loop/evals/` before changing its structure.
- Run and record representative Claude scenarios for setup, one-off eval, interactive generate/evaluate/recovery, parallel scheduling, teardown, and full-engine handoff.

Exit criterion: the pre-split behavior has an executable baseline against which Phase 1 can prove preservation.

### Phase 1: Extract and tighten the shared contract

- Split the current 465-line skill into the shared references above.
- Keep `SKILL.md` as the concise entry point, safety statement, workflow selector, and host-adapter router.
- Reword its frontmatter from "INSIDE an interactive Claude Code session" to host-neutral trigger text.
- Export the canonical runner payload type; add `errors` to both `buildRunRolePayload` branches and add `--json` to `sparra role run` and `sparra eval`, both through that builder. Add `--resume-session <id>` and `--resume-backend <b>` to `sparra role run` so the CLI can thread the same resume inputs as MCP.
- Update `agents/sparra-role.md` to return every decision field, not only a prose digest.
- Preserve all current Claude behavior while removing duplicated rules. In particular, keep the literal Claude scheduling instruction to "launch every runnable role in ONE message" and its under-scheduling tripwire in `references/claude-code.md`; the shared scheduler may use the generalized launch/refill rule.

Exit criteria:

- Claude `/sparra-loop` still supports every documented path.
- MCP and `--json` CLI calls produce the same typed, holdout-safe payload, including recovered `resultText`, `errors`, and budget telemetry.
- The conductor can decide every recovery branch using only the worker summary.
- The main skill remains comfortably below the progressive-disclosure ceiling.

### Phase 2: Add the Codex adapter and plugin

- Write `references/codex.md` with future delegated-worker, current background-CLI, and blocking direct-MCP modes in that order.
- Add `.codex-plugin/plugin.json`.
- Complete the long-call timeout and PATH declaration spike; add `.codex-plugin/mcp.json` only if validated.
- Add starter prompts for one-off evaluation, an interactive cross-model loop, and a stepped full build.
- Validate the plugin and exercise the install/reinstall path in a fresh Codex thread.

Exit criteria:

- Installing the Codex plugin makes `sparra-loop` discoverable.
- A fresh Codex thread can launch a background JSON CLI role, and can reach `run_role`/`remove_unit_worktree` or receives exact registration instructions including `tool_timeout_sec`.
- The skill never references Claude-only tools on the Codex path.

### Phase 3: Make scheduling equivalent and capacity-aware

- Port the parallel-safety matrix unchanged.
- Use conservative launch/refill scheduling over background CLI processes; capability-gate delegated scheduling for a future host.
- Verify distinct `unitWorktree` generators may run concurrently.
- Verify evaluator/reviewer snapshot worktrees are isolated.
- Verify `remove_unit_worktree` and `role rm-worktree` teardown on accept/abandon.
- Ensure blocking direct MCP remains correct when concurrency is unavailable and a multi-minute timeout is configured.

Exit criteria:

- Multiple units make progress without two writers sharing a workspace.
- More runnable units than the conservative process limit are queued rather than dropped.
- The conductor stays responsive during background CLI roles today and during delegated roles if a future host exposes them.

### Phase 4: Documentation and operational parity

- Update `README.md` with Codex installation alongside Claude installation.
- Update `docs/role-runner.md` with Codex plugin, MCP, direct CLI, and fresh-thread instructions.
- Update `skills/sparra/SKILL.md` and diagnosis material where installation/failure signatures change.
- Update repository guidance that currently describes only `.claude-plugin` versioning.
- Bump the Claude marketplace version when its shared skill/worker changes and set the Codex plugin version/cachebuster.

Exit criteria:

- A new user can install and run either host path without reading source files.
- Every user-facing behavior changed by the port is documented in all applicable layers.

### Phase 5: Verification and dogfood

Add durable skill evaluations plus repository tests.

Static/repository checks:

- validate the Codex plugin manifest;
- validate the skill frontmatter and references;
- test that both manifests point to real files;
- test the one shared payload builder through representative MCP, `role run --json`, and `eval --json` paths rather than maintaining separate projection rules;
- test that evaluator summaries omit `traceDir` and holdout-bearing content;
- test non-evaluator recovery preserves `resultText` plus `errors`, and all payload fields except optional `resultDigest` are copied verbatim;
- run `npm run typecheck && npm test`.

Interactive scenarios:

1. **Zero-setup eval:** from an uninitialized target project, evaluate WIP through Codex and receive a redacted verdict.
2. **Cross-model loop:** Codex conducts a Claude-generator/Codex-evaluator loop through at least one fail/fix/re-grade cycle.
3. **Reverse split:** Codex conducts a Codex-generator/Claude-evaluator loop.
4. **Collapsed independence:** force or simulate fallback to the generator's identity and verify the conductor refuses to accept it as cross-model evidence.
5. **Recovery:** simulate limit, turn cap, budget cap, no progress, and empty completion with landed files; verify the next action follows the envelope and that resumable cases continue the same session through the background CLI path, not only MCP.
6. **Parallel units:** on current Codex, exceed the configured background-process limit and verify queue/refill; repeat with delegated workers only when the host exposes that capability.
7. **Holdout wall:** confirm neither conductor nor workers read holdout files, evaluator traces are never surfaced, and only redacted verdict evidence feeds generation.
8. **Full engine handoff:** drive `sparra build --step=contract,round,commit,item` from Codex without reimplementing the autonomous loop.
9. **Claude regression:** rerun representative Claude Code scenarios after the shared-core refactor.

Persist skill eval prompts and objective assertions under the skill's `evals/` directory so future changes can be compared against the prior version rather than relying only on narrative dogfood notes.

## Acceptance criteria

The work is complete when all of the following are true:

- `sparra-loop` can be installed and triggered in a fresh interactive Codex session.
- The Codex conductor can use every Sparra role and both backend families.
- Cross-model identity is checked using the actual post-fallback backend/model.
- The holdout never enters conductor or generator context.
- Worker summaries contain every field required for deterministic recovery decisions.
- Delegation is used when available, background JSON CLI is first-class on current Codex (including same-session recovery), and blocking direct MCP is timeout-safe as a last resort.
- Scheduling respects Sparra's workspace-safety matrix and conservatively queues/refills when Codex capacity is not queryable.
- One-off eval, interactive role choreography, and full `build --step` flows all work.
- Claude Code behavior remains intact after extracting the shared core.
- Codex and Claude installation/use documentation is current.
- Codex plugin validation, typecheck, tests, skill evals, and both-host dogfood pass.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Codex collaboration tools or slot counts differ by environment | Capability-gate delegation; use conservative background-process launch/refill today |
| Plugin MCP command works only from the source checkout | Prefer the linked/installed PATH bin; require bundling before any snapshot-relative server |
| Direct MCP role calls exceed Codex's default 60-second timeout | Exercise a multi-minute call and configure `tool_timeout_sec`; keep blocking MCP last |
| A root MCP declaration affects Claude development sessions | Keep Codex MCP config under `.codex-plugin/`, never repository-root `.mcp.json` |
| Shared skill accumulates host-specific branches again | Host adapter references; shared core contains no tool names |
| Worker summaries silently omit control fields | Canonical envelope plus projection tests |
| Context isolation is mistaken for the holdout boundary | State explicitly that runner redaction/scope enforcement is authoritative |
| Claude behavior regresses during refactor | Snapshot/eval the current Claude skill and run both-host scenarios |
| Skill grows beyond useful context size | Progressive disclosure and targeted references |

## Decisions and remaining Phase 2 validation

1. Use a personal local marketplace during dogfood; installed plugins establish the manifest and cachebuster pattern.
2. Default to the installed/linked `sparra-run-mcp` PATH bin. A plugin-relative server is out unless Sparra bundles its runtime; Phase 2 still validates PATH resolution, non-colliding `./.codex-plugin/mcp.json`, and where `tool_timeout_sec` must live.
3. Current Codex has no delegation or queryable worker capacity. Use a conservative background-process limit and refill queue; capability-gate future delegated workers.
4. Export a runner-side `RunRolePayload`, add `errors` to `buildRunRolePayload`, and reuse that builder for `sparra role run`/`sparra eval` `--json`; add role-run CLI resume flags matching the MCP resume inputs.

The only material spike outcomes left open are whether plugin-local MCP config accepts the timeout and reliably resolves the PATH bin. If either fails, installation documents explicit Codex MCP registration with the timeout; background JSON CLI remains the primary adapter either way.
