import path from "node:path";
import { ensureDir, writeTextIfAbsent } from "./util/io.ts";

/**
 * The Sparra-owned nested `.sparra/.gitignore` (the terraform/direnv pattern). A FAIL-CLOSED
 * ALLOWLIST: the first effective rule ignores everything under `.sparra/`, then re-includes ONLY
 * the durable, cross-machine-shareable set — this file, `config.yaml`, `prompts/` (incl.
 * `.baseline.json`), and `calibration/`. Everything else — `state.json` (machine-local absolute
 * paths), `environment.md`/`memory.md` (per-machine), `frozen/` (holds `HOLDOUT.frozen.md`),
 * `traces/`, `verdicts/`, `runs/`, and ANY future dir — stays ignored by construction. A new
 * holdout-bearing subdir is ignored automatically: it must be explicitly allowlisted to ride git.
 *
 * The isolation invariant is therefore NOT "the whole `.sparra` dir is untracked" but "no
 * HOLDOUT-BEARING `.sparra` content is ever tracked — the allowlist admits only
 * config.yaml/prompts/calibration".
 *
 * Written write-if-absent so a user's own edits to this file are never clobbered.
 */
export const SPARRA_GITIGNORE = `# Sparra-owned nested .gitignore — fail-closed allowlist.
#
# Ignore EVERYTHING under .sparra/ by default, then re-include ONLY the durable set that is
# safe to commit and share across machines. Machine-local and holdout-bearing artifacts
# (state.json, environment.md, memory.md, frozen/, traces/, verdicts/, runs/, conduct/, …
# and any FUTURE dir) stay ignored by construction — a new subdir must be explicitly
# allowlisted here to be tracked, so a future holdout-bearing dir is ignored automatically.
#
# To share the durable set across machines, drop your top-level \`.sparra/\` ignore line (if
# any). NEVER commit HOLDOUT.md — \`sparra finish\` refuses to land while it is tracked.
*
!/.gitignore
!/config.yaml
!/prompts/
!/prompts/**
!/calibration/
!/calibration/**
`;

/**
 * Canonical on-disk layout. The filesystem is Sparra's source of truth and the
 * only state shared between sessions. Human-facing docs live in `docsDir`
 * (the project root by default, or a subfolder like `docs/` set at `sparra init`);
 * machinery lives under .sparra/.
 */
export class Paths {
  /**
   * @param root     project root
   * @param docsDir  subfolder (relative to root) for human-facing docs, or "" for the root
   */
  constructor(
    public readonly root: string,
    public readonly docsDir: string = ""
  ) {}

  // --- human-facing docs (root by default, or `docsDir`) ---
  /** Directory the human-facing docs live in (root when `docsDir` is empty). */
  get docsBase() {
    return this.docsDir ? path.join(this.root, this.docsDir) : this.root;
  }
  get codebaseMap() {
    return path.join(this.docsBase, "CODEBASE_MAP.md");
  }
  get plan() {
    return path.join(this.docsBase, "PLAN.md");
  }
  get changelog() {
    return path.join(this.docsBase, "CHANGELOG.md");
  }
  get prototypes() {
    return path.join(this.root, "prototypes");
  }

  // --- .sparra machinery ---
  get dir() {
    return path.join(this.root, ".sparra");
  }
  get config() {
    return path.join(this.dir, "config.yaml");
  }
  /** The Sparra-owned nested allowlist `.gitignore` (see `SPARRA_GITIGNORE`). */
  get gitignore() {
    return path.join(this.dir, ".gitignore");
  }
  get state() {
    return path.join(this.dir, "state.json");
  }
  get memory() {
    return path.join(this.dir, "memory.md");
  }
  get environment() {
    return path.join(this.dir, "environment.md");
  }
  get frozen() {
    return path.join(this.dir, "frozen");
  }
  get frozenPlan() {
    return path.join(this.frozen, "PLAN.frozen.md");
  }
  get frozenMap() {
    return path.join(this.frozen, "CODEBASE_MAP.frozen.md");
  }
  /** Evaluator-only acceptance checks the generator never sees (isolation wall). */
  get holdout() {
    return path.join(this.docsBase, "HOLDOUT.md");
  }
  get frozenHoldout() {
    return path.join(this.frozen, "HOLDOUT.frozen.md");
  }
  get snapshots() {
    return path.join(this.dir, "snapshots");
  }
  get workitems() {
    return path.join(this.dir, "workitems");
  }
  get workitemsFile() {
    return path.join(this.workitems, "items.json");
  }
  get contracts() {
    return path.join(this.dir, "contracts");
  }
  get verdicts() {
    return path.join(this.dir, "verdicts");
  }
  get reviews() {
    return path.join(this.dir, "reviews");
  }
  get proposals() {
    return path.join(this.dir, "proposals");
  }
  get prompts() {
    return path.join(this.dir, "prompts");
  }
  get calibration() {
    return path.join(this.dir, "calibration");
  }
  get reflect() {
    return path.join(this.dir, "reflect");
  }
  /** Post-accept measure artifacts (rendered reports) + the default baseline location. Lives under
   *  the MAIN repo `.sparra` so a baseline survives an isolated worktree build's teardown. */
  get measure() {
    return path.join(this.dir, "measure");
  }
  get measureBaseline() {
    return path.join(this.measure, "baseline.json");
  }
  get traces() {
    return path.join(this.dir, "traces");
  }
  get runs() {
    return path.join(this.dir, "runs");
  }
  /** Archived past cycles (one subdir per completed plan→build cycle). */
  get cycles() {
    return path.join(this.dir, "cycles");
  }
  cycleDir(name: string) {
    return path.join(this.cycles, name);
  }

  /** Records the hash of the DEFAULT_PROMPTS text last seeded/synced per role, so `promptDrift`
   *  can tell a stale-vs-default copy from your own local edit. A dotfile — never a role prompt. */
  get promptBaseline() {
    return path.join(this.prompts, ".baseline.json");
  }

  promptFile(role: string) {
    return path.join(this.prompts, `${role}.md`);
  }
  contractFile(itemId: string) {
    return path.join(this.contracts, `${itemId}.contract.md`);
  }
  /** Autonomous evaluator verdict file. When a `runId` is given the file lands in a RUN-SCOPED
   *  subdir (`verdicts/<runId>/<item>.rN.verdict.md`) so two build runs that reuse item ids (the
   *  common u1–u4 convention) never clobber each other; a resumed run keeps the same `runId`, so it
   *  writes alongside its own earlier rounds. Omitting `runId` preserves the flat legacy layout. */
  verdictFile(itemId: string, round: number, runId?: string) {
    const dir = runId ? path.join(this.verdicts, runId) : this.verdicts;
    return path.join(dir, `${itemId}.r${round}.verdict.md`);
  }
  /** Interactive role-run verdict file. Named with a caller-supplied unique token (a timestamp +
   *  random suffix) so two evaluator role-runs grading the same item across process restarts produce
   *  DISTINCT files (uniqueness never rides on an in-process counter alone). */
  roleRunVerdictFile(roleKind: string, token: string) {
    return path.join(this.verdicts, `role-run-${roleKind}-${token}.verdict.md`);
  }
  reviewFile(itemId: string, round: number) {
    return path.join(this.reviews, `${itemId}.r${round}.review.md`);
  }
  traceDir(runId: string) {
    return path.join(this.traces, runId);
  }

  async ensureScaffold(): Promise<void> {
    await Promise.all([
      ensureDir(this.docsBase),
      ensureDir(this.dir),
      ensureDir(this.frozen),
      ensureDir(this.snapshots),
      ensureDir(this.workitems),
      ensureDir(this.contracts),
      ensureDir(this.verdicts),
      ensureDir(this.reviews),
      ensureDir(this.proposals),
      ensureDir(this.prompts),
      ensureDir(path.join(this.calibration, "good")),
      ensureDir(path.join(this.calibration, "slop")),
      ensureDir(this.reflect),
      ensureDir(this.measure),
      ensureDir(this.traces),
      ensureDir(this.runs),
      ensureDir(this.cycles),
    ]);
    // Sparra-owned nested allowlist `.gitignore` — write-if-absent so config/prompts/calibration
    // can ride git across machines while everything else (incl. any future dir) stays ignored by
    // construction. Never clobbers a user-edited file. Shared by init/new/finish via this choke point.
    await writeTextIfAbsent(this.gitignore, SPARRA_GITIGNORE);
  }
}
