# Sparra in interactive Claude Code — design exploration

> **Status:** the MVP is **built** — the policy role-runner + `sparra role run` CLI + MCP `run_role`
> server + the `sparra-loop` skill. See **[../role-runner.md](../role-runner.md)** for usage. This
> page is the design/planning record. Produced as a Sparra-style planning session: **Claude (Opus) as
> planner, Codex (gpt-5.5) as the adversarial partner** via `codex exec` — two design rounds, plus a
> Codex code-review of the implementation whose findings were fixed (holdout-read-from-disk deny,
> sanitized leak errors, Codex `readOnly`/`writeScope` intent, contract-var fills, fail-closed holdout).

## The question
How do we bring Sparra's methodology — collaborative **plan → freeze → build (per item: contract →
generate → adversarial evaluate → grade → review → pivot/accept) → reflect**, over **pluggable
backends (Claude + Codex + …)** with the **filesystem as the source of truth** — into an
**interactive Claude Code session**, via some mix of **agent skills, subagents, and plugins**, while
keeping the ability to use **non-Claude backends (Codex/others)** for roles?

## The headline conclusion (after adversarial review)
**Don't reimplement Sparra's engine as a markdown skill.** Sparra's guarantees live in *code*, not in
prose: the `runSession` choke point (`src/sdk/session.ts`), the **code-enforced holdout wall**
(`assertNoHoldoutLeak` in `src/build/holdout.ts`, applied in `generate.ts`/`contract.ts`, injected
only in `evaluate.ts`), guard construction (`settingSources:[]`, scoped-write hooks, Codex sandbox),
and persisted `.sparra/` state. A skill that *tells* the main Claude session to "act like Sparra" is
weaker, harder to resume, and trivially bypassed.

Instead: **expose Sparra's existing role machinery as a callable, policy-enforcing runner, and let
interactive Claude Code DRIVE it through a narrow tool.** The rigor stays in code; CC adds the human
in the loop. Most of the work is *a new front door onto code Sparra already has* — not a new engine.

This reframe came directly from the Codex adversarial pass, which was right: the v1 "skills + subagents
+ shell-out dispatch" sketch underestimated where the guarantees live and would have leaked the
holdout through the main session's shared context.

## Architecture (converged)

### 1. A **policy runner** over `runSession` — not raw `runSession`
`runSession` is only the backend choke point. Holdout enforcement, contract injection, verdict
parsing, and guard selection live in the *role* layer (`src/build/{generate,contract,evaluate}.ts`).
So introduce a higher-level **`RoleRunRequest`** that owns the *policy*, and lowers into the existing
`AgentRequest`:

```
RoleRunRequest {
  roleKind: "generator" | "contract-generator" | "contract-evaluator" | "evaluator" | "reviewer"
  backend:  "claude" | "codex" | …          // the cross-model lever, reused as-is
  model?, effort?
  workspace: string
  briefPath | brief: string                 // the task/contract brief
  contractPath?: string
  holdoutPath?: string                      // a PATH, never contents
  holdoutPolicy: "forbid" | "inject-evaluator-only"
  verdictOut?: string                       // where the normalized verdict/result lands
  readOnly? / writeScope?                    // lowered to AgentRequest safety intent
}
```
The runner: reads the holdout **itself** (only for `evaluator`), runs `assertNoHoldoutLeak` against
generator/contract briefs **before any backend call**, selects the right guard, calls `runSession`,
then does Sparra's shape-aware verdict extraction + weighted recompute. Crucially, **`holdoutPath`
does NOT go on the generic `AgentRequest`** (that invites accidental propagation to arbitrary
roles/traces) — it stays a policy concern in `RoleRunRequest`.

`sparra role run --role evaluator --backend codex --holdout .sparra/HOLDOUT.md …` is then a Codex
evaluator grading a Claude generator's work with every Sparra guard intact — the cross-model "killer
feature," reused rather than re-built.

### 2. **MCP `run_role` server is the interactive surface (MVP), CLI is for tests/scripting**
Because the main CC session **must never see the holdout**, the policy boundary must be a tool that
accepts an **opaque path/handle** and returns only normalized artifacts (verdict + a path). A
shell-driven conductor can always `cat HOLDOUT.md`; an MCP tool lets the interactive surface be
*intentionally narrower*. So:
- **MCP `run_role(roleKind, backend, briefPath, contractPath, workspace, holdoutPath?, …)`** — the
  conductor's only way to launch a role. Enforces holdout access server-side; returns the verdict.
- **`sparra role run` CLI** — the same runner, for scripting/tests/headless. (A human at a shell can
  bypass holdout; that's fine for CI, not for the interactive wall.)

### 3. Interactive CC is a **thin driver**, never the rigor
- A small **skill** (`/sparra-loop`) tells the conductor the *procedure*: write the brief/contract →
  `run_role(generator)` (scoped writes) → `run_role(evaluator, backend=codex, holdoutPath=…,
  read-only)` → read the **verdict** (not the holdout) → pivot/accept *with the human*.
- **Subagents** are optional Claude-side context isolation; they are **not** the portable backend
  (subagents are Claude-only). Cross-model always comes from the runner.
- **State** = the existing `.sparra/` (contracts, verdicts, traces) — inspectable, resumable, already
  understood by Sparra tooling. No new state machine.

### 4. Isolation lives in the runner, not in CC hooks
The interactive session has ambient tools, prior conversation, and shared context — you cannot claim
Sparra-grade isolation from CC hooks alone. The runner owns allowed-tools + sandbox (`settingSources:
[]`, scoped hooks, Codex sandbox), and is the only context that materializes holdout.

## MVP — build exactly one thing first
**`run_role` (MCP) over the existing seam, proving the evaluator + holdout path.** Loop:
1. Human/conductor writes a brief + contract.
2. `run_role(generator, backend=claude)` — scoped writes into the workspace.
3. `run_role(evaluator, backend=codex, holdoutPath=…, readOnly)` — the **only** reader of holdout;
   exercises the artifact; emits a verdict.
4. Verdict → `.sparra/verdicts/…`; the conductor reads the **verdict**, not the holdout; steers.

**Single highest-leverage proof (Codex's pick):** ship `run_role(evaluator, backend=codex,
holdoutPath=…)` that injects the holdout and returns a parsed verdict — **with a test proving that a
generator/contract role given the same holdout path throws before any backend call.** That one slice
de-risks the whole idea (cross-model + isolation + verdict parsing) at once.

**Defer:** plugin packaging, multiple skills, reflect, contract-negotiation automation, reviewer, a
subagent zoo, any new state machine.

## Honest assessment — is it worth building?
- **Interactive CC is genuinely better** at human steering: rewriting contracts, choosing pivots,
  judging whether an evaluator failure is *meaningful*, inspecting artifacts/traces with the conductor
  between rounds.
- **It is worse** at unattended rigor: shared context is a contamination risk, manual steps hurt
  resumability, the session can read forbidden files, and cost/latency are more visible.
- **Verdict:** worth building **only if the runner is first-class and enforces isolation.** If it
  degrades into "a markdown skill that asks Claude to behave like Sparra," just run
  `sparra build --only <item>` and use CC to inspect artifacts between rounds — that already exists.

## Open risks / blind spots to resolve first
1. **Holdout boundary** must be enforced in the runner/MCP, not trusted to the session. (Confirmed.)
2. **Trace hygiene:** Sparra's backend traces embed full prompt text, so *evaluator* traces will
   contain the holdout — the runner must mark/scope evaluator traces as evaluator-only.
3. **Read-scope validation:** `additionalDirectories` can silently grant broad reads; the role runner
   must validate scope centrally, not trust the caller.
4. **Output contract:** prefer `outputSchema`, but keep Sparra's shape-aware verdict extraction +
   recompute (Claude's schema mode is emulated; evaluator output is noisy).
5. **Cross-machine auth:** the runner must reach Claude/Codex SDK auth without brittle setup (Codex
   SDK uses `~/.codex`; Claude uses CC login / API key).
6. **Does it beat `sparra build --only <item>` + inspect-between-rounds?** The interactive value must
   be real, not a reskin.

---

## Adversarial exchange (Claude planner ⇄ Codex adversary)

**Round 1 — Codex's teardown of v1 (skills + subagents + shell-out dispatch):**
1. The draft underestimates where Sparra's guarantees live (code, not a markdown checklist).
2. The holdout wall doesn't survive a main-session conductor that can read everything — the conductor
   must never read holdout; an isolated role must be the only context that materializes it.
3. "Subagents = roles" is only half true — subagents are Claude-only; they don't give pluggable
   backends.
4. Don't build dispatch as ad-hoc `claude -p`/`codex exec`; reuse the existing `AgentBackend`/
   `runSession` seam or you regress structured output, tracing, rate-limit handling, auth, resume.
5. An MCP `run_role` server beats raw CLI exec for a real policy boundary.
6. Hooks aren't a full safety story; the interactive session has ambient tools — isolation needs a
   constrained runner that owns allowed-tools.

**Round 2 — Codex on the revised v2 (runner-first):**
1. Agrees runner-first is correct — **but** it can't be "literally thin `runSession`"; holdout policy
   lives in the role layer, so expose a **policy runner over `runSession`**.
2. **MCP-first** for the interactive MVP (a shell conductor can `cat HOLDOUT.md`; MCP narrows the surface).
3. `AgentRequest` is enough as the *backend* call but not as the *role-runner API* — add a
   higher-level `RoleRunRequest` with `roleKind` / `holdoutPath` / `holdoutPolicy` / `contractPath` /
   `verdictOut`; do **not** put `holdoutPath` on generic `AgentRequest`.
4. Highest-leverage proof: `run_role(evaluator, backend=codex, holdoutPath=…)` + a test that a
   generator/contract role with the same holdout path throws before any backend call.
5. Blind spots: evaluator **trace hygiene** (holdout in prompt traces), **read-scope** validation,
   keep the **shape-aware verdict** path even with `outputSchema`.

Both rounds are reflected in the architecture above; the two agents converged on the runner-first,
MCP-surfaced, policy-enforcing design.

## Implementation & adversarial-review trail
Built overnight with Codex as the adversarial reviewer at each step (per the user's ask):
1. **Design round 1** → Codex teardown reframed it to runner-first (rigor in code, not a skill).
2. **Design round 2** → policy runner over `runSession`, MCP-first, add a `RoleRunRequest` policy layer.
3. **Code review of the first runner** → caught: forbid roles could read holdout from disk; leak errors
   echoed holdout snippets; Codex `readOnly`/`writeScope` unwired; placeholder-strip corrupted contract
   prompts; fail-open on a bad holdout path. All fixed.
4. **Ship/no-ship review** → NO-SHIP: evaluator could leak holdout to the conductor via verdict
   evidence/blocking/notes (and `--out`/MCP); on-disk deny too narrow; trace collisions. Fixed:
   verdict **redaction**, `.sparra/`-wide read-deny + relative-path resolution, randomUUID trace dirs.
5. **Confirm review** → one residual: untrusted evaluator JSON could smuggle holdout in an *extra*
   assertion property. Fixed: assertions normalized to exactly `{id,pass,evidence}`.
6. **Final sign-off** → leak closed; **shippable: yes.**

Shipped: `src/build/roleRun.ts`, `src/phases/role.ts` (`sparra role run`), `src/mcp/runRoleServer.ts`
+ `bin/sparra-run-mcp.mjs` (MCP `run_role`), `skills/sparra-loop/`, `test/roleRun.test.ts` (17 tests),
`docs/role-runner.md`.
