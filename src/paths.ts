import path from "node:path";
import { ensureDir } from "./util/io.ts";

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
  get state() {
    return path.join(this.dir, "state.json");
  }
  get memory() {
    return path.join(this.dir, "memory.md");
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

  promptFile(role: string) {
    return path.join(this.prompts, `${role}.md`);
  }
  contractFile(itemId: string) {
    return path.join(this.contracts, `${itemId}.contract.md`);
  }
  verdictFile(itemId: string, round: number) {
    return path.join(this.verdicts, `${itemId}.r${round}.verdict.md`);
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
      ensureDir(this.traces),
      ensureDir(this.runs),
      ensureDir(this.cycles),
    ]);
  }
}
