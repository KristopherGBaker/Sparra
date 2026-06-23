# Example: greenfield CLI build (`eh`)

A runnable, watchable end-to-end demo of Sparra's autonomous build loop. It builds **`eh`**, a tiny dependency-free Node.js CLI calculator, from a frozen plan — so you can watch **Phase C** (contract negotiation → generation → adversarial exercising → grading) without first doing the interactive interview yourself.

## Run it

```bash
# from the repo root, with an Anthropic credential available
npm install
bash examples/cli-greenfield/run.sh
```

That will, in a throwaway `examples/cli-greenfield/.work/` directory:

1. `sparra init` — detect greenfield, scaffold `.sparra/`.
2. Drop in the tuned [`config.yaml`](config.yaml) (sonnet for the code-writing/judging roles, haiku for the rest; small round/assertion limits so it finishes quickly).
3. `sparra freeze` — lock the shipped [`PLAN.md`](PLAN.md) as build input.
4. `sparra build` — the autonomous loop:
   - decompose the plan (→ a single `eh.js` item),
   - **negotiate a "done" contract** (generator proposes assertions; adversarial evaluator hardens them),
   - **generate** `eh.js`,
   - **exercise it for real** via `mcp__exercise__run_command` (runs `node eh.js …`, checks stdout/exit codes),
   - **grade** against the contract + rubric, pivot/patch if needed, accept on pass.
5. Exercise the built CLI in front of you (`add/sub/mul/div`, plus the div-by-zero and bad-input error paths).

## What to look at afterward

Everything is on disk in `.work/.sparra/`:

- `contracts/item-001.contract.md` — the full generator↔evaluator negotiation and the AGREED contract.
- `verdicts/` — per-round scores and which assertions passed/failed, with evidence.
- `traces/<run>/` — every agent's full transcript as readable markdown.
- `CHANGELOG.md` — any deviations the generator recorded.

Then try the outer loop:

```bash
node ../../bin/sparra.mjs reflect --root .work     # propose prompt improvements from the traces
```

## Want to drive it yourself?

Skip `run.sh` and do the real flow in a fresh directory:

```bash
mkdir my-cli && cd my-cli
sparra init
sparra plan          # the collaborative interview builds PLAN.md with you
sparra freeze
sparra build
```
