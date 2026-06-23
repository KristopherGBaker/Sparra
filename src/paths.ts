import path from "node:path";
import { ensureDir } from "./util/io.ts";

/**
 * Canonical on-disk layout. The filesystem is Sparra's source of truth and the
 * only state shared between sessions. Key human-facing files live at the project
 * root; machinery lives under .sparra/.
 */
export class Paths {
  constructor(public readonly root: string) {}

  // --- root-level, human-facing ---
  get codebaseMap() {
    return path.join(this.root, "CODEBASE_MAP.md");
  }
  get plan() {
    return path.join(this.root, "PLAN.md");
  }
  get changelog() {
    return path.join(this.root, "CHANGELOG.md");
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

  promptFile(role: string) {
    return path.join(this.prompts, `${role}.md`);
  }
  contractFile(itemId: string) {
    return path.join(this.contracts, `${itemId}.contract.md`);
  }
  verdictFile(itemId: string, round: number) {
    return path.join(this.verdicts, `${itemId}.r${round}.verdict.md`);
  }
  traceDir(runId: string) {
    return path.join(this.traces, runId);
  }

  async ensureScaffold(): Promise<void> {
    await Promise.all([
      ensureDir(this.dir),
      ensureDir(this.frozen),
      ensureDir(this.snapshots),
      ensureDir(this.workitems),
      ensureDir(this.contracts),
      ensureDir(this.verdicts),
      ensureDir(this.proposals),
      ensureDir(this.prompts),
      ensureDir(path.join(this.calibration, "good")),
      ensureDir(path.join(this.calibration, "slop")),
      ensureDir(this.reflect),
      ensureDir(this.traces),
      ensureDir(this.runs),
    ]);
  }
}
