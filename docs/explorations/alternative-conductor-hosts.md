# Alternative conductor hosts: opencode and Pi

Exploratory notes — **nothing here is built**. Snapshot as of 2026-07-11; upstream capabilities
move fast, so verify against the linked sources before acting.

## Why look

Sparra's interactive loop is conducted today from **Claude Code** (first-class) and **Codex CLI**
(experimental / WIP — see the caveat in [../role-runner.md](../role-runner.md#codex-install-and-run)).
The Codex conductor path lags and may stay that way until Codex exposes better host capabilities. So
the question: is there an **alternative host harness that runs OpenAI/Codex models** and can conduct
the same loop as well as (or better than) Claude Code? Note the distinction this whole doc rests on —
Codex/OpenAI models as a *backend* (a role that builds or judges, the cross-model seam) are fully
supported and unaffected; the gap is purely the *interactive conductor host*.

Two credible open-source candidates: **opencode** and **Pi**.

## What a conductor host must provide

Distilled from the `sparra-loop` skill adapters ([claude-code.md](../../skills/sparra-loop/references/claude-code.md),
[scheduling.md](../../skills/sparra-loop/references/scheduling.md)). In rough priority:

1. **Delegated subagents with isolated context, summary-only return** — spawn a child that runs one
   role and returns a *short* structured summary; the raw diff / full verdict / holdout-adjacent
   trace never enters the conductor's context. This is the load-bearing capability (it's how the
   holdout wall stays intact at the host layer — cf. Sparra's `sparra-role` Claude subagent).
2. **Bounded-concurrent, long-running role-runs** — launch ~3 isolated role-runs at once
   (minutes each), non-blocking, and collect results. Ideally by shelling `sparra role run --json`
   / `sparra eval --json` as background JSON processes, or via MCP.
3. **MCP client** — to call Sparra's `run_role` tool directly. Optional: the CLI/JSON path is a
   full fallback.
4. **Skill / command / plugin packaging** — ship the `sparra-loop` instructions + reference files
   as a loadable, triggerable bundle.
5. **Runs OpenAI/Codex models** — the point of the alternative host.
6. **Shell/tool use** — git + `sparra` CLI.
7. **Long-run tolerance** — no aggressive per-tool timeout killing a multi-minute role run (Codex
   CLI's 60 s default `tool_timeout_sec` was a real problem we raised to 1800 s).

## opencode (sst / anomalyco)

MIT, TypeScript on Bun. [github.com/sst/opencode](https://github.com/sst/opencode) · [opencode.ai/docs](https://opencode.ai/docs/)

- **#1 subagents — SUPPORTED (native).** The Task tool spawns a child session and returns a concise
  summary to the parent; agents are markdown in `.opencode/agents/*.md`, each with its own context,
  tools, and model. A near-1:1 analogue of `sparra-role`.
- **#2 concurrency — the one real gap.** Subagents run *sequentially* (`tasks.pop()` in the session
  loop); no background bash. Parallel *MCP* tool calls do run concurrently, but their output
  re-enters the parent context, sacrificing #1's isolation. So today it's isolation **or**
  concurrency, not both.
- **#3 MCP — SUPPORTED (strong):** `mcp` block in `opencode.json`, stdio local + remote servers,
  per-agent enable. **#4 packaging — SUPPORTED:** commands (`/name`), agents, plugins (JS/TS),
  `AGENTS.md`. **#5 models — SUPPORTED:** provider-agnostic, GPT-5 / "GPT-5.1 Codex" documented.
  **#6 shell — SUPPORTED.** **#7 timeout — PARTIAL:** 2-min default bash timeout, env-var raisable;
  some background-child hang bugs.
- **Bottom line:** a **sequential** Sparra conductor is **config-only (S, ~1–2 days)** — a
  `/sparra-loop` command, a `sparra-role` summary-only agent, an `opencode.json` MCP entry, an
  `AGENTS.md`, and a timeout bump; **holdout isolation intact**, one role-run at a time. The only
  missing piece vs. the Claude Code adapter is *concurrent isolated* role-runs — a **modest core
  scheduler patch (M)** to make `tasks.pop()` a bounded-parallel scheduler; community forks
  (opencode-parallel-agents, an agent-teams port) are already circling it.

## Pi (earendil-works / pi, pi.dev)

MIT, TypeScript. [github.com/earendil-works/pi](https://github.com/earendil-works/pi) · [pi.dev](https://pi.dev)

Pi's thesis is the opposite of "batteries-included": *"a minimal agent harness. Adapt Pi to your
workflows, not the other way around."* It ships powerful defaults but **deliberately omits
sub-agents, background bash, and MCP from core** — each is a first-class extension you add (or
install as a **Pi package** via npm/git). Its own framing: *"Ask Pi to build what you want, or
install a package that does it your way… change the harness, not your workflow."* Pi can even
**modify itself in place** — ask it to add a command/tool/provider/workflow, hit `/reload`, keep
going.

- **#1 subagents — Not in core, buildable (Partial).** README: *"No sub-agents. Spawn Pi instances
  via tmux, or build your own with extensions."* The **SDK** (`createAgentSession` /
  `AgentSessionRuntime`) is purpose-built for spawning a child session and capturing only its final
  output. The **oh-my-pi fork** ([github.com/can1357/oh-my-pi](https://github.com/can1357/oh-my-pi))
  already ships exactly this: isolated workers whose *"final yield is a schema-validated object the
  parent reads directly"* — i.e. Sparra's holdout-safe summary-only pattern, pre-built.
- **#2 concurrency — Not in core, buildable (Partial):** no native background job (README: *"No
  background bash. Use tmux."*); oh-my-pi adds PTY / background dispatch + parallel kernels.
  **#3 MCP — Not in core; shell fallback works today.** **#4 packaging — SUPPORTED:** Skills,
  Extensions, Pi Packages (`pi install npm:…` / `git:…`). **#5 models — SUPPORTED:** 20+ providers
  incl. OpenAI GPT-5. **#6 shell — SUPPORTED.** **#7 timeout — SUPPORTED:** 300 s default,
  per-call raisable — no 60 s wall.
- **Four modes** — interactive, print/JSON, **RPC**, and **SDK** — which matters here: a Sparra
  conductor can drive Pi programmatically (SDK/RPC) rather than by prompting, and the JSON mode maps
  cleanly onto shelling `sparra role run --json`. (Pi cites **OpenClaw** as a real-world SDK
  integration.)
- **Bottom line:** more of a **build** on vanilla Pi — #1 subagent isolation is the load-bearing
  piece (**M** via the SDK), #2 concurrency **S–M**. Via **oh-my-pi**, #1/#2/#7 are largely already
  met, so it drops to mostly **packaging (S–M)**.

## Strategic take

| | opencode | Pi |
|---|---|---|
| Philosophy | batteries-included, adapt to *its* model | minimal, mold *it* to your workflow |
| #1 isolated summary subagents | ✅ native | ⚠️ build (SDK) / ✅ via oh-my-pi |
| #2 bounded-concurrent isolated runs | ⚠️ core patch (M) | ⚠️ build / ✅ via oh-my-pi |
| #3 MCP client | ✅ strong | ⚠️ extension (shell fallback fine) |
| Programmatic drive | agent/command markdown | ✅ SDK + RPC + JSON (4 modes) |
| Fastest path to a working conductor | **sequential: config-only (S)** | build/package (S–M via fork) |

Two honest readings, and they point at **different bets**:

- **Fastest working conductor → opencode.** A sequential, holdout-safe loop ships with config-only
  work; parallelism is a known, bounded scheduler patch.
- **Best *fit* for a bespoke conductor → Pi.** A Sparra conductor is a specific, opinionated
  workflow (contract → generate → holdout-safe evaluate, with summary-only subagents and bounded
  concurrency). Pi is explicitly designed to be *molded into exactly that* — and its **SDK/RPC
  modes** let us drive the loop as a program rather than a prompt, which is arguably a cleaner seam
  for Sparra than adapting to another agent's built-in subagent model. The tradeoff (less built in)
  is smaller than it looks, because we'd be *building the conductor anyway* and Pi is the harness
  that most wants to be built on. So **prototyping Pi first is defensible even though opencode has
  more out of the box** — start from the SDK, or from oh-my-pi's isolated workers.

Neither has a blocking architectural mismatch. A reasonable plan: a **spike on each** — an opencode
sequential conductor (a day) as the baseline, and a Pi SDK-driven conductor spike to test whether the
"mold the harness" thesis produces a *better* seam than adapting to opencode. Decide from the spikes,
not from the feature lists.

## Decision & status (2026-07-11)

Both were spiked and driven LIVE (spike repo: `~/code/experiments/pi-sparra-conductor`). Findings:

- The load-bearing capabilities **#1 (isolated summary-only child)** and **#2 (bounded concurrency)**
  are **host-agnostic** — a subprocess boundary + a deterministic allowlist redaction + a plain
  `node` pool ran unchanged under both a Pi SDK child session and an opencode subagent. So neither
  host's built-in subagent is load-bearing for the holdout wall.
- Pi was proven end-to-end: a Codex (`gpt-5.6-sol`) child session drove the real `sparra eval`
  (Claude) and returned only the redacted summary; 3 concurrent live sessions ran isolated with no
  cross-talk. opencode's native subagent was also confirmed live on its free model.

**Decision: build the Pi conductor** (its SDK/RPC lets the loop be driven as a *program*, the cleaner
fit for Sparra's opinionated loop), keeping **opencode as a future option** that would reuse the same
core. Work now lives in this repo under **[`../../conductors/`](../../conductors/)**: the host-agnostic
`conductors/core` (built + tested) consumes the canonical envelope `src/roleEnvelope.ts`; the Pi
adapter (`conductors/pi/`) is next.

## Sources

- opencode: [repo](https://github.com/sst/opencode) · [agents](https://opencode.ai/docs/agents/) ·
  [mcp](https://opencode.ai/docs/mcp-servers/) · sequential-subagents [#14195](https://github.com/sst/opencode/issues/14195) ·
  background-bash [#24885](https://github.com/sst/opencode/issues/24885)
- Pi: [repo](https://github.com/earendil-works/pi) · [pi.dev](https://pi.dev) ·
  [coding-agent README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md) ·
  bash-timeout [#5484](https://github.com/earendil-works/pi/issues/5484) ·
  oh-my-pi fork [repo](https://github.com/can1357/oh-my-pi)
