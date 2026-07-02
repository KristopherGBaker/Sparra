import path from "node:path";
import type { Ctx } from "../context.ts";
import { runVerifyCommand, type CommandExecutor } from "./exec.ts";
import { readText, writeText, stampFromDate } from "../util/io.ts";

/**
 * The post-accept MEASURE core: parse the project's structured metrics, diff them against a
 * stored baseline, flag regressions, render an artifact, and (unless compare-only) update the
 * baseline. Every side effect is behind INJECTED deps (the command runner + file read/write) so
 * `test/measure.test.ts` and `test/build.test.ts` never spawn a process or touch disk — the same
 * `spawnFn`/`CommandExecutor` seam pattern the rest of the build loop uses.
 *
 * DESIGN (locked): measure is NON-BLOCKING — a regression is a signal (artifact + memory line +
 * reflect feed), never a gate. The measure COMMAND owns metric semantics (name, value, goal
 * min/max, unit); Sparra owns baseline storage, delta computation, regression flagging, the
 * artifact, and the reflect feed. The command runs with cwd = the WORKTREE where the accepted
 * artifact lives, but the baseline JSON is read/written from the MAIN repo `.sparra` (via
 * `ctx.paths`) so it survives worktree teardown — the two paths are kept distinct by the caller.
 */

export type Goal = "min" | "max";

/** One named metric: a value, a goal direction, and an optional unit for the report. */
export interface Metric {
  value: number;
  goal: Goal;
  unit?: string;
}

/** The metrics the command emitted this run, keyed by name. */
export type Metrics = Record<string, Metric>;
/** The stored baseline, same shape as `Metrics` (a JSON object keyed by metric name). */
export type Baseline = Record<string, Metric>;

/** One metric's comparison against the baseline. */
export interface Delta {
  name: string;
  current: number;
  /** Absent when the metric is new (no baseline entry, or a baseline value of 0). */
  baseline?: number;
  goal: Goal;
  unit?: string;
  /** Not in the baseline (or baseline value 0) — recorded, never a regression. */
  isNew: boolean;
  /** Worsened past the threshold in the goal's bad direction. Never true when `isNew`. */
  regressed: boolean;
  /** Fractional change in the goal's BAD direction relative to the baseline (only when not new). */
  pct?: number;
}

/** Result of a measure run — carries enough for the memory line, the reflect feed, and the CLI. */
export interface MeasureResult {
  /** The command actually spawned (false = rejected by the safety rules, never ran). */
  ran: boolean;
  /** The run produced usable metrics AND completed (exit 0, parseable). */
  ok: boolean;
  metrics: Metrics;
  deltas: Delta[];
  /** The subset of `deltas` with `regressed: true`. */
  regressions: Delta[];
  /** Path the rendered markdown report was written to (absent only when nothing was written). */
  reportPath?: string;
  /** True when the baseline file was written this run (compare-only never writes; parse failure never writes). */
  baselineUpdated: boolean;
  /** Human-readable reason when `ok` is false (unsafe / non-zero exit / parse failure). */
  reason?: string;
}

/** Injected side effects — a command runner and file read/write, all faked in tests. */
export interface MeasureDeps {
  exec: CommandExecutor;
  readFile: (file: string) => Promise<string | null>;
  writeFile: (file: string, content: string) => Promise<void>;
}

/** The real deps: the no-shell safe executor + the io helpers. */
export function realMeasureDeps(): MeasureDeps {
  return { exec: runVerifyCommand, readFile: readText, writeFile: writeText };
}

/** Coerce one raw metric value (a bare number or an object) into a Metric, or null if unusable. */
function coerceMetric(v: unknown, defaultGoal: Goal): Metric | null {
  if (typeof v === "number" && isFinite(v)) return { value: v, goal: defaultGoal };
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    const value = Number(o.value);
    if (!isFinite(value)) return null;
    const goal: Goal = o.goal === "max" ? "max" : o.goal === "min" ? "min" : defaultGoal;
    const unit = typeof o.unit === "string" ? o.unit : undefined;
    return unit !== undefined ? { value, goal, unit } : { value, goal };
  }
  return null;
}

/** Find the end index of the object starting at `start` ('{'), respecting strings/escapes. -1 = no match. */
function matchBrace(text: string, start: number): number {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Every balanced top-level JSON object that PARSES, left to right (leading log lines tolerated). */
function topLevelJsonObjects(text: string): unknown[] {
  const out: unknown[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === "{") {
      const end = matchBrace(text, i);
      if (end > i) {
        try {
          out.push(JSON.parse(text.slice(i, end + 1)));
        } catch {
          /* not valid JSON — skip this span */
        }
        i = end + 1;
        continue;
      }
    }
    i++;
  }
  return out;
}

/**
 * Parse the LAST top-level JSON object in `stdout` that carries a `metrics` field, tolerating
 * leading non-JSON log lines. Accepts a bare-number metric (goal = `defaultGoal`) and an object
 * metric (`{ value, goal?, unit? }`). Returns null on malformed / no-metrics stdout (or when the
 * `metrics` object holds no usable entries) — a clearly-signalled failure, never a throw.
 */
export function parseMetrics(stdout: string, defaultGoal: Goal): Metrics | null {
  const objs = topLevelJsonObjects(stdout);
  let raw: Record<string, unknown> | null = null;
  for (const o of objs) {
    if (o && typeof o === "object" && "metrics" in o) {
      const m = (o as { metrics: unknown }).metrics;
      if (m && typeof m === "object" && !Array.isArray(m)) raw = m as Record<string, unknown>; // LAST wins
    }
  }
  if (!raw) return null;
  const metrics: Metrics = {};
  for (const [name, v] of Object.entries(raw)) {
    const m = coerceMetric(v, defaultGoal);
    if (m) metrics[name] = m;
  }
  return Object.keys(metrics).length ? metrics : null;
}

/**
 * Diff current metrics against a baseline. A metric regresses when it worsens past `threshold`
 * (fraction) in its goal's bad direction: `goal:"min"` → `(current-baseline)/baseline > threshold`;
 * `goal:"max"` → `(baseline-current)/baseline > threshold`. A metric absent from the baseline —
 * or whose baseline value is 0 (no percentage computable) — is `isNew` and never `regressed`. A
 * change within ±threshold either direction is not a regression.
 */
export function computeDeltas(current: Metrics, baseline: Baseline, threshold: number): Delta[] {
  const deltas: Delta[] = [];
  for (const [name, m] of Object.entries(current)) {
    const b = baseline[name];
    if (!b || b.value === 0) {
      deltas.push({ name, current: m.value, goal: m.goal, unit: m.unit, isNew: true, regressed: false });
      continue;
    }
    const pct = m.goal === "min" ? (m.value - b.value) / b.value : (b.value - m.value) / b.value;
    deltas.push({
      name,
      current: m.value,
      baseline: b.value,
      goal: m.goal,
      unit: m.unit,
      isNew: false,
      regressed: pct > threshold,
      pct,
    });
  }
  return deltas;
}

/** Load a baseline JSON, tolerating a missing/empty/malformed file (→ empty baseline, no throw). */
export async function loadBaseline(file: string, read: MeasureDeps["readFile"] = readText): Promise<Baseline> {
  const text = await read(file);
  if (!text || !text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: Baseline = {};
  for (const [name, v] of Object.entries(parsed as Record<string, unknown>)) {
    const m = coerceMetric(v, "min");
    if (m) out[name] = m;
  }
  return out;
}

/** Persist metrics as the new baseline JSON (keyed by name). */
export async function saveBaseline(file: string, metrics: Metrics, write: MeasureDeps["writeFile"] = writeText): Promise<void> {
  await write(file, JSON.stringify(metrics, null, 2) + "\n");
}

/** Format one delta's change for a report/memory line (e.g. `p50_ms 12.3→30.9 ms (+151%)`). */
function fmtDelta(d: Delta): string {
  const unit = d.unit ? ` ${d.unit}` : "";
  if (d.isNew || d.baseline === undefined) return `${d.current}${unit} (new)`;
  const pct = d.pct === undefined ? "" : ` (${d.pct >= 0 ? "+" : ""}${Math.round(d.pct * 100)}%)`;
  return `${d.baseline}→${d.current}${unit}${pct}`;
}

export interface RenderReportInput {
  command: string;
  ran: boolean;
  ok: boolean;
  metrics: Metrics;
  deltas: Delta[];
  regressions: Delta[];
  compareOnly: boolean;
  baselineUpdated: boolean;
  reason?: string;
  at: string;
}

/** Render the measure artifact (markdown). Pure, so it's directly testable. */
export function renderReport(r: RenderReportInput): string {
  const lines: string[] = [];
  lines.push(`# Measure report — ${r.at}`);
  lines.push("");
  lines.push(`- command: \`${r.command}\``);
  lines.push(`- status: ${r.ran ? (r.ok ? "ok" : "not ok") : "not run"}${r.reason ? ` (${r.reason})` : ""}`);
  lines.push(`- mode: ${r.compareOnly ? "compare-only (baseline not written)" : r.baselineUpdated ? "baseline updated" : "baseline unchanged"}`);
  lines.push(`- regressions: ${r.regressions.length}`);
  lines.push("");
  if (r.deltas.length) {
    lines.push("| metric | current | baseline | change | goal | status |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    for (const d of r.deltas) {
      const base = d.isNew || d.baseline === undefined ? "—" : String(d.baseline);
      const change = d.isNew ? "new" : d.pct === undefined ? "—" : `${d.pct >= 0 ? "+" : ""}${Math.round(d.pct * 100)}%`;
      const status = d.regressed ? "**REGRESSED**" : d.isNew ? "new" : "ok";
      lines.push(`| ${d.name} | ${d.current}${d.unit ? ` ${d.unit}` : ""} | ${base} | ${change} | ${d.goal} | ${status} |`);
    }
  } else {
    lines.push("_no metrics_");
  }
  lines.push("");
  return lines.join("\n") + "\n";
}

/** One-line summary for the memory learning + CLI (regressions, new baseline, or no-op). */
export function renderMeasureLearning(r: MeasureResult): string {
  if (!r.ran) return `measure not run (${r.reason ?? "unsafe command"}); baseline unchanged.`;
  if (!r.ok) return `measure produced no usable metrics (${r.reason ?? "parse failure"}); baseline unchanged.`;
  if (r.regressions.length) {
    const named = r.regressions.map((d) => `${d.name} ${fmtDelta(d)}`).join(", ");
    return `measure: ${r.regressions.length} regression(s) — ${named.slice(0, 220)}${r.baselineUpdated ? "; baseline updated" : ""}.`;
  }
  const total = Object.keys(r.metrics).length;
  const newCount = r.deltas.filter((d) => d.isNew).length;
  if (total > 0 && newCount === total) {
    return `measure: no baseline yet — recorded ${total} metric(s)${r.baselineUpdated ? " as the new baseline" : ""}.`;
  }
  return `measure: no regressions across ${total} metric(s)${newCount ? `, ${newCount} new` : ""}${r.baselineUpdated ? "; baseline updated" : ""}.`;
}

export interface RunMeasureOptions {
  /** The single argv command to run (its own value is the executor opt-in past the argv[0] allowlist). */
  command: string;
  /** cwd for the command — the WORKTREE holding the accepted artifact (NOT the baseline dir). */
  cwd: string;
  /** Baseline JSON path — resolved from the MAIN repo `.sparra`, never the worktree. */
  baselineFile: string;
  /** Dir for the rendered artifact — also under the MAIN repo `.sparra`. */
  reportDir: string;
  threshold: number;
  defaultGoal: Goal;
  /** compare-only: parse + diff + report, but DON'T write the baseline. */
  compareOnly?: boolean;
  /** Injectable clock for a deterministic artifact filename in tests. */
  now?: () => Date;
}

/**
 * Run the project's measure command, parse metrics, diff against the baseline, render an artifact,
 * and (unless `compareOnly`) update the baseline. Never throws for an expected failure:
 *   - an unsafe/unknown command (rejected by the executor) → `ran:false, ok:false` with the reason;
 *   - a non-zero exit → `ran:true, ok:false` with the exit captured;
 *   - unparseable / no-metrics stdout → `ok:false` AND the baseline is NEVER written or overwritten
 *     (a parse failure must not clobber a good baseline with an empty one).
 */
export async function runMeasure(opts: RunMeasureOptions, deps: MeasureDeps): Promise<MeasureResult> {
  const now = opts.now ?? (() => new Date());
  const at = now().toISOString();
  const writeReport = async (input: Omit<RenderReportInput, "at" | "command" | "compareOnly">): Promise<string> => {
    const file = path.join(opts.reportDir, `measure-${stampFromDate(now())}.md`);
    await deps.writeFile(file, renderReport({ ...input, command: opts.command, compareOnly: !!opts.compareOnly, at }));
    return file;
  };

  // 1) Run the command through the safe executor (its own value is the argv[0]-allowlist opt-in).
  const outcome = await deps.exec(opts.cwd, opts.command, { allowPrefixes: [opts.command] });
  if (!outcome.ran) {
    const reason = `command not run — unsafe for the harness executor: ${outcome.unsafeReason}`;
    const reportPath = await writeReport({ ran: false, ok: false, metrics: {}, deltas: [], regressions: [], baselineUpdated: false, reason });
    return { ran: false, ok: false, metrics: {}, deltas: [], regressions: [], reportPath, baselineUpdated: false, reason };
  }
  if (outcome.exitCode !== 0) {
    const reason = `command exited ${outcome.exitCode}${outcome.timedOut ? " (timed out)" : ""}`;
    const reportPath = await writeReport({ ran: true, ok: false, metrics: {}, deltas: [], regressions: [], baselineUpdated: false, reason });
    return { ran: true, ok: false, metrics: {}, deltas: [], regressions: [], reportPath, baselineUpdated: false, reason };
  }

  // 2) Parse metrics. A parse failure NEVER writes the baseline (guard: don't clobber a good one).
  const metrics = parseMetrics(outcome.stdout, opts.defaultGoal);
  if (!metrics) {
    const reason = "no parseable metrics on stdout (expected a JSON object with a `metrics` field)";
    const reportPath = await writeReport({ ran: true, ok: false, metrics: {}, deltas: [], regressions: [], baselineUpdated: false, reason });
    return { ran: true, ok: false, metrics: {}, deltas: [], regressions: [], reportPath, baselineUpdated: false, reason };
  }

  // 3) Diff against the baseline (read from the MAIN repo `.sparra`).
  const baseline = await loadBaseline(opts.baselineFile, deps.readFile);
  const deltas = computeDeltas(metrics, baseline, opts.threshold);
  const regressions = deltas.filter((d) => d.regressed);

  // 4) Update the baseline unless compare-only, then write the artifact.
  let baselineUpdated = false;
  if (!opts.compareOnly) {
    await saveBaseline(opts.baselineFile, metrics, deps.writeFile);
    baselineUpdated = true;
  }
  const reportPath = await writeReport({ ran: true, ok: true, metrics, deltas, regressions, baselineUpdated });
  return { ran: true, ok: true, metrics, deltas, regressions, reportPath, baselineUpdated };
}

/**
 * Wire a measure run to a Ctx: resolve the baseline from the MAIN repo `.sparra` (via `ctx.paths`,
 * never the worktree), run the command with cwd = `workspaceDir` (the worktree with the accepted
 * artifact). This is the seam the build loop and `sparra measure` both call; it is injected into
 * `BuildDeps` so tests can fake the whole step.
 */
export async function measureAcceptedItem(
  ctx: Ctx,
  workspaceDir: string,
  opts: { compareOnly?: boolean; now?: () => Date } = {},
  deps: MeasureDeps = realMeasureDeps()
): Promise<MeasureResult> {
  const m = ctx.config.measure;
  const baselineFile = m.baselineFile ? path.resolve(ctx.root, m.baselineFile) : ctx.paths.measureBaseline;
  return runMeasure(
    {
      command: m.command,
      cwd: workspaceDir,
      baselineFile,
      reportDir: ctx.paths.measure,
      threshold: m.regressionThreshold,
      defaultGoal: m.defaultGoal,
      compareOnly: opts.compareOnly,
      now: opts.now,
    },
    deps
  );
}
