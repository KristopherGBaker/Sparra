import { spawnSync } from "node:child_process";
import { TypeSafeClient, choice, noul } from "@typesafe-ai/sdk";
import { mapBounded } from "../../conductors/core/bounded.ts";
import { defaultConfig, type ReflectShippedCheckConfig, type SparraConfig } from "../config.ts";
import { info, warn } from "../util/log.ts";
import { JudgeResponseError, clipChars, clipFinding, type JevClient, type JevClientFactory } from "./reflectDedupe.ts";
import type { InboxFinding } from "./upstreamTriage.ts";

/**
 * `sparra reflect --upstream --check-shipped`: compare each live upstream-inbox finding with the repo's
 * recent commits via TypeSafe's Jev model and PRINT `--done` suggestions for findings a commit already
 * fixed. It never triages. Invoking the flag is the consent to send inbox finding text + commit
 * messages to TypeSafe (nothing else: no traces, verdicts, or file content). Design invariants, shared
 * with `reflectDedupe.ts`: ONE (finding, commit) pair per request, TWO questions per request (a Noul
 * "does it fix?" + a Choice separating fixes from partially-addresses), untrusted-response validation,
 * fail-open (a failed pair is skipped and summarized in ONE warn, never thrown).
 */

export type ShippedRelation = "fixes" | "partially_addresses" | "unrelated";
const RELATIONS: readonly ShippedRelation[] = ["fixes", "partially_addresses", "unrelated"];

export interface ShippedVerdict {
  /** Noul probability that the commit fixes the finding's problem (0..1). */
  fixed: number;
  relation: ShippedRelation;
}

/** Judge one (finding, commit) pair. Rejects on any failure — callers treat a rejection as a failed pair. */
export type ShippedJudge = (findingText: string, commitText: string) => Promise<ShippedVerdict>;

/** A recent non-merge commit. */
export interface CommitInfo {
  sha: string;
  subject: string;
  body: string;
}

/** Reads the newest `count` non-merge commits (newest first) of the repo at `root`. Injectable for tests. */
export type CommitSource = (root: string, count: number) => CommitInfo[];

type ShippedState = { finding: string; commit: string };
function buildQuestions() {
  return {
    fixed: noul("Does `commit` fix the problem described in `finding`?", {
      true: "The commit's change resolves the defect or gap the finding reports.",
      false: "The commit does not resolve it, even if it touches the same area.",
    }),
    relation: choice("How does `commit` relate to the problem in `finding`?", {
      fixes: "It resolves the reported problem.",
      partially_addresses: "It changes the same behavior but leaves part of the problem unresolved.",
      unrelated: "It does not address this problem.",
    }),
  };
}
type ShippedQuestions = ReturnType<typeof buildQuestions>;

export type ShippedJevClient = JevClient<ShippedState, ShippedQuestions>;
export type ShippedClientFactory = JevClientFactory<ShippedJevClient>;

/** The production factory: the key is passed EXPLICITLY (never via `process.env`); SDK logging off. */
export const defaultShippedClientFactory: ShippedClientFactory = ({ apiKey, model }) =>
  new TypeSafeClient({ apiKey, defaultModel: model, logLevel: "off", retry: { maxRetries: 1 } });

/** Validate an untrusted `systemOne` response into a `ShippedVerdict`; throws `JudgeResponseError`. */
function parseVerdict(res: unknown): ShippedVerdict {
  const answers = (res as { answers?: Record<string, unknown> } | null | undefined)?.answers;
  if (!answers || typeof answers !== "object") throw new JudgeResponseError("missing answers");
  return checkVerdict({
    fixed: (answers.fixed as { noul?: unknown } | null | undefined)?.noul,
    relation: (answers.relation as { choice?: unknown } | null | undefined)?.choice,
  });
}

/** Validate a judge's verdict — applied to injected judges too, since any judge's output is untrusted. */
function checkVerdict(v: unknown): ShippedVerdict {
  const { fixed, relation } = (v ?? {}) as { fixed?: unknown; relation?: unknown };
  if (typeof fixed !== "number" || !Number.isFinite(fixed) || fixed < 0 || fixed > 1) {
    throw new JudgeResponseError("fixed score missing or outside [0, 1]");
  }
  if (typeof relation !== "string" || !RELATIONS.includes(relation as ShippedRelation)) {
    throw new JudgeResponseError("relation missing or unknown");
  }
  return { fixed, relation: relation as ShippedRelation };
}

/** Access settings borrowed from `reflect.dedupe`; anything unusable falls back to the defaults. */
function jevAccess(cfg: SparraConfig): { model: string; apiKeyEnv: string } {
  const def = defaultConfig().reflect.dedupe;
  const src = (cfg.reflect?.dedupe ?? {}) as Partial<Record<"model" | "apiKeyEnv", unknown>>;
  const pick = (k: "model" | "apiKeyEnv"): string => (typeof src[k] === "string" && src[k].trim() !== "" ? src[k] : def[k]);
  return { model: pick("model"), apiKeyEnv: pick("apiKeyEnv") };
}

/**
 * Build the Jev (finding, commit) judge, or null when the key env var is unset/empty. The key is read
 * from `process.env[apiKeyEnv]` here and never logged or persisted; no client is constructed without one.
 */
export function createShippedJudge(
  access: { model: string; apiKeyEnv: string },
  factory: ShippedClientFactory = defaultShippedClientFactory,
): ShippedJudge | null {
  const apiKey = process.env[access.apiKeyEnv];
  if (!apiKey) return null;
  const client = factory({ apiKey, model: access.model });
  return async (findingText, commitText) => {
    const res = await client.systemOne({
      state: { finding: clipFinding(findingText), commit: clipChars(commitText.trim()) },
      questions: buildQuestions(),
      model: access.model,
    });
    return parseVerdict(res);
  };
}

const isFraction = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
const isPositiveInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 1;

/** Sanitize a possibly-hand-edited `reflect.shippedCheck` block: bad values → defaults, ONE `warn`. Never throws. */
export function normalizeShippedConfig(cfg: Partial<ReflectShippedCheckConfig> | null | undefined): ReflectShippedCheckConfig {
  const out = { ...defaultConfig().reflect.shippedCheck };
  const src = (cfg && typeof cfg === "object" ? cfg : {}) as Record<string, unknown>;
  const bad: string[] = [];
  for (const k of ["commits", "concurrency"] as const) {
    if (src[k] === undefined) continue;
    if (isPositiveInt(src[k])) out[k] = src[k];
    else bad.push(k);
  }
  if (src.threshold !== undefined) {
    if (isFraction(src.threshold)) out.threshold = src.threshold;
    else bad.push("threshold");
  }
  if (bad.length > 0) warn(`reflect.shippedCheck: invalid ${bad.join(", ")} — using defaults for ${bad.length === 1 ? "it" : "them"}.`);
  return out;
}

/**
 * Validate `--check-shipped` / `--commits` against the rest of the `reflect` flags. Throws BEFORE any
 * judge or client is built. Returns whether the check is requested and the `--commits` override.
 */
export function validateShippedFlags(opts: {
  upstream?: boolean;
  clear?: boolean;
  done?: string | boolean;
  wontdo?: string | boolean;
  checkShipped?: boolean | string;
  commits?: string | number | boolean;
}): { check: boolean; commits?: number } {
  const check = opts.checkShipped !== undefined && opts.checkShipped !== false;
  if (opts.checkShipped !== undefined && typeof opts.checkShipped !== "boolean") {
    throw new Error("--check-shipped takes no value");
  }
  if (!check) {
    if (opts.commits !== undefined) throw new Error("--commits requires --check-shipped");
    return { check: false };
  }
  if (!opts.upstream) throw new Error("--check-shipped requires --upstream");
  const conflicts = [
    opts.done !== undefined ? "--done" : null,
    opts.wontdo !== undefined ? "--wontdo" : null,
    opts.clear ? "--clear" : null,
  ].filter((f): f is string => f !== null);
  if (conflicts.length > 0) throw new Error(`--check-shipped cannot be combined with ${conflicts.join(", ")}`);
  if (opts.commits === undefined) return { check: true };
  const raw = opts.commits;
  const n = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  if (!Number.isSafeInteger(n) || n < 1) throw new Error("--commits requires a positive integer (e.g. --commits 30)");
  return { check: true, commits: n };
}

const FIELD_SEP = "\x1f";
const RECORD_SEP = "\x1e";

/**
 * Production commit source: `git log --no-merges` in `root` (argv array — no shell, no interpolation).
 * A non-repo, a repo with no commits, or any git failure yields `[]`; a `count` beyond the history just
 * returns what exists.
 */
export const readRecentCommits: CommitSource = (root, count) => {
  const r = spawnSync(
    "git",
    ["log", "--no-merges", "--no-show-signature", "-n", String(count), `--format=%h${FIELD_SEP}%s${FIELD_SEP}%b${RECORD_SEP}`],
    { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (r.status !== 0 || !r.stdout) return [];
  const commits: CommitInfo[] = [];
  for (const record of r.stdout.split(RECORD_SEP)) {
    const [sha, subject, body] = record.replace(/^\n/, "").split(FIELD_SEP);
    if (!sha || subject === undefined) continue;
    commits.push({ sha, subject, body: (body ?? "").trim() });
  }
  return commits;
};

/** Text sent to the judge for one commit: `<short sha> <subject>\n<body>`. */
export function commitText(c: CommitInfo): string {
  return `${c.sha} ${c.subject}\n${c.body}`.trim();
}

/**
 * Index of the commit a finding is likely shipped in, or -1. `verdicts[i]` is against commit `i`
 * (newest first; null = failed pair). Qualifies: `fixed ≥ threshold` AND relation `fixes`. The highest
 * noul wins; ties go to the newest commit (lowest index). Depends only on scores + commit order —
 * never on completion timing.
 */
export function pickShippedCommit(verdicts: (ShippedVerdict | null)[], threshold: number): number {
  let best = -1;
  verdicts.forEach((v, i) => {
    if (!v || v.relation !== "fixes" || v.fixed < threshold) return;
    if (best < 0 || v.fixed > verdicts[best]!.fixed) best = i;
  });
  return best;
}

/** Test seams + per-call overrides for `runShippedCheck`. */
export interface ShippedCheckOptions {
  /** `--commits <n>`: overrides `reflect.shippedCheck.commits`. */
  commits?: number;
  /** Injected pair judge; when absent the real Jev judge is built from `reflect.dedupe` + the env key. */
  judge?: ShippedJudge;
  /** Injected SDK-client factory for the real judge. */
  clientFactory?: ShippedClientFactory;
  /** Injected commit reader (default: `readRecentCommits`). */
  commitSource?: CommitSource;
}

/**
 * Judge every live finding against the recent commits (bounded concurrency, one request per pair) and
 * print `--done` suggestions. Writes nothing to the inbox. Fail-open: never throws on judge trouble.
 */
export async function runShippedCheck(
  ctx: { root: string; config: SparraConfig },
  findings: InboxFinding[],
  opts: ShippedCheckOptions = {},
): Promise<void> {
  if (findings.length === 0) return;
  const cfg = normalizeShippedConfig(ctx.config.reflect?.shippedCheck);
  const access = jevAccess(ctx.config);
  if (!opts.judge && !process.env[access.apiKeyEnv]) {
    warn(`--check-shipped: ${access.apiKeyEnv} is not set — skipping the shipped check (no request sent).`);
    return;
  }
  const count = opts.commits ?? cfg.commits;
  const commits = (opts.commitSource ?? readRecentCommits)(ctx.root, count);
  if (commits.length === 0) {
    info("--check-shipped: no non-merge commits found in this repo — nothing to compare.");
    return;
  }
  const judge = opts.judge ?? createShippedJudge(access, opts.clientFactory);
  if (!judge) return; // unreachable (key checked above); keeps the type total
  info(`Checking ${findings.length} finding(s) against the last ${commits.length} commit(s) via Jev…`);

  const texts = commits.map(commitText);
  const pairs = findings.flatMap((_, f) => commits.map((_c, c) => ({ f, c })));
  const errorNames = new Set<string>();
  let failures = 0;
  const results = await mapBounded(
    pairs,
    async ({ f, c }) => {
      try {
        return checkVerdict(await judge(findings[f]!.text, texts[c]!));
      } catch (e) {
        failures++;
        errorNames.add(e instanceof Error ? e.name : "non-Error rejection");
        return null;
      }
    },
    { concurrency: cfg.concurrency },
  );
  if (failures > 0) {
    warn(`--check-shipped: ${failures} of ${pairs.length} judge request(s) failed (${[...errorNames].join(", ")}) — those pairs were skipped.`);
  }

  const hits: { finding: InboxFinding; commit: CommitInfo; p: number }[] = [];
  findings.forEach((finding, f) => {
    const verdicts = results.slice(f * commits.length, (f + 1) * commits.length);
    const best = pickShippedCommit(verdicts, cfg.threshold);
    if (best >= 0) hits.push({ finding, commit: commits[best]!, p: verdicts[best]!.fixed });
  });
  hits.sort((a, b) => a.finding.globalIndex - b.finding.globalIndex);

  if (hits.length === 0) {
    process.stdout.write(`\nNo inbox finding looks already shipped in the last ${commits.length} commit(s).\n`);
    return;
  }
  const lines = hits.map((h) => `#${h.finding.globalIndex} ${h.finding.title} — likely shipped in ${h.commit.sha} ${h.commit.subject} (p=${h.p.toFixed(2)})`);
  const ids = hits.map((h) => h.finding.globalIndex).join(",");
  const shas = [...new Set(hits.map((h) => h.commit.sha))].join(" ");
  process.stdout.write(`\n${lines.join("\n")}\n\nsparra reflect --upstream --done ${ids} --reason "shipped (Jev check): ${shas}"\n`);
}
