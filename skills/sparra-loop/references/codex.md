# Codex adapter

Use the first mode the current Codex host actually supports. The configured role backend remains
independent of the conductor host.

## 1. Future delegated worker — capability-gated

Only when Codex exposes delegation and permits it, give one bounded worker exactly one runnable
role invocation, its runner arguments, the holdout discipline, and the canonical-envelope
requirement. Let it use a discovered Sparra MCP capability or the CLI fallback, return only the
canonical summary, and refill available capacity as workers complete. Do not assume a fixed slot
count: query a stable capacity surface when one exists, otherwise use the conservative queue from
the next mode.

## 2. Current background CLI — PRIMARY

Current Codex has no usable delegation surface. Launch matrix-safe calls as background processes
through the installed `sparra` PATH command. Redirect stdout to a distinct adapter-owned JSON file;
`--out` remains a caller-selected runner artifact, not the JSON envelope:

```bash
sparra role run --kind generator --brief brief.md --contract contract.md --backend claude --json --out result.md > role-envelope.json &
sparra eval . --worktree --contract contract.md --backend codex --json > eval-envelope.json &
```

Use the conservative bound of **3 simultaneous processes**: launch matrix-safe runnable roles up
to the bound, queue the rest, and refill open slots as processes complete. More runnable roles than
the bound are queued, never dropped. Wait for a process to complete before reading and parsing its
JSON envelope. Do not import raw transcripts or evaluator traces into conductor context. Use the
fresh-process CLI when dogfooding runner changes so every call executes current code rather than a
stale persistent MCP server.

Resume a stopped call using the prior envelope's backend and session ID:

```bash
sparra role run --kind generator --brief brief.md --contract contract.md --json \
  --resume-session <id> --resume-backend <backend> > resumed-envelope.json &
```

On both accept and abandon paths, tear down a persistent unit worktree with
`sparra role rm-worktree --name <name>`; add `--force` only after deliberately accepting its WIP
safety tradeoff.

## 3. Blocking direct MCP — LAST resort

Use direct MCP only when neither delegated workers nor background processes are available. Discover
capabilities named `run_role` and `remove_unit_worktree` at runtime; never hard-code their fully
qualified names because plugin namespaces can change them. Persist the canonical, holdout-safe
summary immediately. With no concurrency, run blocking direct MCP roles sequentially with the
configured multi-minute `tool_timeout_sec` (`1800`). State that execution is blocking and
capacity-limited. Never request raw output or expose verbose traces.

The codex-cli 0.144.1 spike found three requirements and limitations:

- Codex applies a per-server `tool_timeout_sec`; its 60-second default kills real multi-minute
  `run_role` calls. Direct MCP requires a value well above 60 seconds, at least `1800`.
- Headless `codex exec` policy-rejected a direct role call as a data-export risk. Direct MCP is
  approval-gated and requires interactive approval; it is not an unattended fallback.
- The `sparra-run-mcp` PATH bin must exist. Install the package or run `npm link` in its checkout
  before expecting the plugin declaration to start the server.

These constraints keep direct MCP last even when tool discovery succeeds.

## Discovery and fallback

Detect the unqualified `run_role` and `remove_unit_worktree` capabilities rather than assuming a
runtime prefix. Prefer the background JSON CLI whenever `sparra` is on PATH. If `run_role` is
unavailable or approval is denied, stay on that CLI path. If `remove_unit_worktree` is unavailable,
use `sparra role rm-worktree --name <name>`.

The plugin declares the PATH server in `.codex-plugin/mcp.json` with
`tool_timeout_sec: 1800`. Discovery failure therefore means checking package installation/PATH and
reloading the plugin; it does not justify guessing a qualified tool name.
