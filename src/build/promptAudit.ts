import path from "node:path";
import type { Ctx } from "../context.ts";
import type { RoleConfig } from "../config.ts";
import { DEFAULT_PROMPTS, loadPrompt } from "../prompts.ts";
import { runSession } from "../sdk/session.ts";
import type { RunResult, RunSessionParams } from "../sdk/session.ts";
import { extractJsonWhere } from "../util/extract.ts";
import { writeText, stampFromDate } from "../util/io.ts";

/**
 * Conciseness auditor for Sparra's OWN role prompts. `reflect` APPENDS, so DEFAULT_PROMPTS
 * ratchets up over cycles; this measures whether wording can be tightened WITHOUT losing any
 * rule, and (only behind a fail-closed coverage guard) applies the tightened version.
 *
 * Safety: the audit operates ONLY on role-prompt TEXT — it passes NO holdout path, injects no
 * holdout/memory/plan, and the auditor role is READ-ONLY (no Write/Edit/Bash tools; the prompt
 * is passed inline). The HARNESS writes the review and (gated) applied files.
 */

export interface AuditCoverageEntry {
  rule: string;
  preservedIn?: string;
  dropped?: boolean;
}

export interface AuditResult {
  tightened?: string;
  coverage?: AuditCoverageEntry[];
  droppedNothing?: boolean;
  notes?: string;
}

/** The INDEPENDENT verifier's verdict: it re-derives the original's rules and checks each survives. */
export interface VerifierResult {
  complete?: boolean;
  missing?: Array<{ rule: string }>;
}

/** Deterministic size measure: chars and an approximate token count (chars/4, rounded up). */
export function measurePrompt(text: string): { chars: number; tokens: number } {
  const chars = text.length;
  return { chars, tokens: Math.ceil(chars / 4) };
}

/**
 * The apply decision — FAIL-CLOSED + coverage cross-check. We do NOT trust the self-reported
 * `droppedNothing` alone: the coverage array must be present, non-empty, and carry no dropped
 * entry, and the tightened text must be a real non-blank string. Anything else → don't apply.
 */
export function shouldApply(a: AuditResult | null | undefined): boolean {
  return (
    !!a &&
    a.droppedNothing === true &&
    !!a.tightened?.trim() &&
    Array.isArray(a.coverage) &&
    a.coverage.length > 0 &&
    !a.coverage.some((c) => c.dropped)
  );
}

/**
 * The INDEPENDENT verifier's apply decision. Unlike `shouldApply`, this does NOT consult the
 * auditor's self-reported coverage — it trusts ONLY a separate verifier pass that re-derives the
 * original's rules from source. Approve ONLY when the verifier explicitly confirms nothing missing.
 */
export function verifierApproves(v: VerifierResult | null | undefined): boolean {
  return v?.complete === true && Array.isArray(v?.missing) && v.missing.length === 0;
}

/** Why an `--apply` was refused — for the warning + review file. */
function skipReason(a: AuditResult | null | undefined): string {
  if (!a) return "unparseable JSON (no audit object returned)";
  if (a.droppedNothing !== true) return "droppedNothing is not true";
  if (!a.tightened?.trim()) return "tightened proposal is empty";
  if (!Array.isArray(a.coverage) || a.coverage.length === 0) return "coverage report is empty";
  if (a.coverage.some((c) => c.dropped)) return "a rule was marked dropped";
  return "coverage guard not satisfied";
}

/** Why the INDEPENDENT verifier refused an `--apply` — distinct from the coverage reason. */
function verifierSkipReason(v: VerifierResult | null | undefined): string {
  if (!v) return "verifier returned unparseable JSON";
  const n = Array.isArray(v.missing) ? v.missing.length : 0;
  return `verifier flagged ${n} missing rule(s)`;
}

export interface AuditRow {
  role: string;
  sizeBefore: { chars: number; tokens: number };
  sizeAfter: { chars: number; tokens: number };
  pctDelta: number;
  droppedNothing: boolean;
  applied: boolean;
  skipped: boolean;
  skipReason?: string;
  reviewPath: string;
}

export interface AuditOptions {
  /** Roles to audit; defaults to ALL roles in DEFAULT_PROMPTS. */
  roles?: string[];
  /**
   * Which prompt text to audit:
   *  - "effective" (default): the EFFECTIVE prompt — on-disk `.sparra/prompts/<role>.md` if present,
   *    else the built-in default (via `loadPrompt`). What a project actually runs.
   *  - "default": the built-in `DEFAULT_PROMPTS[role]` directly — what the HARNESS ships. Use this
   *    to audit Sparra's OWN prompts (a project snapshot can be stale). REPORT-ONLY: `apply` is
   *    refused for this source (applying would rewrite `src/prompts.ts` source, which the tool
   *    does not do — port the proposal by hand).
   */
  source?: "effective" | "default";
  /** Overwrite the on-disk prompt when the coverage guard passes (else report-only). Ignored for source="default". */
  apply?: boolean;
  backend?: string;
  model?: string;
  effort?: RoleConfig["effort"];
  /** Injectable for tests; defaults to the real SDK session. */
  runSessionFn?: (p: RunSessionParams) => Promise<RunResult>;
}

function renderReview(
  role: string,
  before: { chars: number; tokens: number },
  after: { chars: number; tokens: number },
  pctDelta: number,
  parsed: AuditResult | null,
  outcome: string,
  verifier?: { ran: boolean; result: VerifierResult | null }
): string {
  const droppedNothing = parsed?.droppedNothing === true;
  const coverage = Array.isArray(parsed?.coverage) ? parsed!.coverage : [];
  const coverageLines = coverage.length
    ? coverage
        .map((c) =>
          c.dropped ? `- "${c.rule}" → dropped: true` : `- "${c.rule}" → preservedIn: ${c.preservedIn ?? "(unspecified)"}`
        )
        .join("\n")
    : "_no coverage reported_";
  const tightened = typeof parsed?.tightened === "string" && parsed.tightened.trim() ? parsed.tightened : "_none_";
  let verifierSection = "";
  if (verifier?.ran) {
    const v = verifier.result;
    const missing = Array.isArray(v?.missing) ? v!.missing : [];
    const missingLines = missing.length
      ? missing.map((m) => `- "${m.rule}" → missing/weakened`).join("\n")
      : "_none_";
    verifierSection =
      `## Independent verifier\n` +
      `- ran: yes\n` +
      `- complete: ${v?.complete === true}\n` +
      `- missing rules (${missing.length}):\n${missingLines}\n\n`;
  }
  return (
    `# Prompt audit — ${role}\n\n` +
    `- size before: ${before.chars} chars (~${before.tokens} tokens)\n` +
    `- size after:  ${after.chars} chars (~${after.tokens} tokens)\n` +
    `- delta: ${pctDelta}%\n` +
    `- droppedNothing: ${droppedNothing}\n` +
    `- outcome: ${outcome}\n\n` +
    `## Coverage (${coverage.length} rule${coverage.length === 1 ? "" : "s"})\n${coverageLines}\n\n` +
    verifierSection +
    `## Notes\n${parsed?.notes?.trim() || "_none_"}\n\n` +
    `## Tightened proposal\n${tightened}\n`
  );
}

/**
 * Audit one or more role prompts for conciseness. For each role: resolve the EFFECTIVE current
 * prompt (on-disk `.sparra/prompts/<role>.md` if present, else the built-in default — via
 * `loadPrompt`), run the read-only `prompt-auditor` on that text, write a per-role review under
 * `<promptsDir>/audit/<role>.md`, and (only when `apply` AND the coverage guard pass) overwrite
 * the prompt file with the tightened version.
 */
export async function auditPrompts(ctx: Ctx, opts: AuditOptions = {}): Promise<AuditRow[]> {
  const run = opts.runSessionFn ?? runSession;
  const base = ctx.config.roles.reflector; // the self-improvement role — no new config key
  const role: RoleConfig = {
    ...base,
    ...(opts.backend ? { backend: opts.backend } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.effort ? { effort: opts.effort } : {}),
  };
  const targets = opts.roles?.length ? opts.roles : Object.keys(DEFAULT_PROMPTS);
  const system = await loadPrompt(ctx.paths, "prompt-auditor");
  const verifierSystem = await loadPrompt(ctx.paths, "prompt-audit-verifier");
  const traceDir = path.join(ctx.paths.traces, `prompt-audit-${stampFromDate(new Date())}`);

  const rows: AuditRow[] = [];
  let seq = 0;
  // source="default" audits the SHIPPING DEFAULT_PROMPTS directly (for auditing the harness's own
  // prompts, since a project's on-disk snapshot can be stale); it is REPORT-ONLY (never rewrites
  // src/prompts.ts source). source="effective" (default) audits what the project actually runs.
  const fromDefault = opts.source === "default";
  for (const r of targets) {
    seq++;
    const current = fromDefault ? DEFAULT_PROMPTS[r] ?? "" : await loadPrompt(ctx.paths, r);
    const sizeBefore = measurePrompt(current);

    // The auditor is READ-ONLY: the prompt TEXT is inlined; no tools, no holdout/memory/plan.
    const task = `Audit this role prompt for conciseness. Return ONLY the JSON object.

ROLE: ${r}

PROMPT TEXT:
---
${current}
---`;
    const res = await run({
      role: `prompt-auditor-${r}`,
      prompt: task,
      systemPrompt: system,
      backend: role.backend,
      model: role.model,
      effort: role.effort,
      baseUrl: role.baseUrl,
      apiKey: role.apiKey,
      cwd: ctx.root,
      tools: [],
      readOnly: true,
      maxTurns: ctx.config.build.maxTurnsPerSession,
      maxBudgetUsd: ctx.config.build.maxBudgetUsdPerItem,
      traceDir,
      traceSeq: seq,
    });

    const parsed = extractJsonWhere<AuditResult>(
      res.resultText,
      (v) => v && typeof v === "object" && ("tightened" in v || "coverage" in v || "droppedNothing" in v)
    );
    const tightened = typeof parsed?.tightened === "string" ? parsed.tightened : "";
    const sizeAfter = measurePrompt(tightened);
    const pctDelta = sizeBefore.chars > 0 ? Math.round(((sizeAfter.chars - sizeBefore.chars) / sizeBefore.chars) * 100) : 0;
    const droppedNothing = parsed?.droppedNothing === true;

    // First gate: the auditor's own coverage cross-check. source="default" is always report-only
    // (applying would rewrite src/prompts.ts source).
    const coverageOk = !fromDefault && !!opts.apply && shouldApply(parsed);

    // Second, INDEPENDENT gate (--apply only, and only once coverage passed): a separate verifier
    // re-derives the ORIGINAL's rules FROM SOURCE (not from the auditor's coverage) and confirms
    // each survives in the tightened text. This catches rules the auditor MISSED (never enumerated),
    // which the coverage cross-check cannot see. Skipped for report-only / source=default — no call.
    let verifierRan = false;
    let verifierResult: VerifierResult | null = null;
    if (coverageOk) {
      verifierRan = true;
      seq++;
      const vtask = `Independently verify this prompt tightening preserves EVERY rule from the ORIGINAL. Return ONLY the JSON object.

ROLE: ${r}

ORIGINAL PROMPT:
---
${current}
---

PROPOSED TIGHTENED PROMPT:
---
${tightened}
---`;
      const vres = await run({
        role: `prompt-audit-verifier-${r}`,
        prompt: vtask,
        systemPrompt: verifierSystem,
        backend: role.backend,
        model: role.model,
        effort: role.effort,
        baseUrl: role.baseUrl,
        apiKey: role.apiKey,
        cwd: ctx.root,
        tools: [],
        readOnly: true,
        maxTurns: ctx.config.build.maxTurnsPerSession,
        maxBudgetUsd: ctx.config.build.maxBudgetUsdPerItem,
        traceDir,
        traceSeq: seq,
      });
      verifierResult = extractJsonWhere<VerifierResult>(
        vres.resultText,
        (v) => v && typeof v === "object" && ("complete" in v || "missing" in v)
      );
    }

    // Effective apply = coverage cross-check AND independent verifier approval.
    const apply = coverageOk && verifierApproves(verifierResult);
    const skipped = !fromDefault && !!opts.apply && !apply;
    const reason = skipped
      ? verifierRan
        ? verifierSkipReason(verifierResult)
        : skipReason(parsed)
      : undefined;
    const outcome = apply
      ? "APPLIED"
      : fromDefault && opts.apply
        ? "report-only (source=default: port to src/prompts.ts by hand)"
        : opts.apply
          ? `SKIPPED (${reason})`
          : "report-only";

    const reviewPath = path.join(ctx.paths.prompts, "audit", `${r}.md`);
    await writeText(
      reviewPath,
      renderReview(r, sizeBefore, sizeAfter, pctDelta, parsed, outcome, { ran: verifierRan, result: verifierResult })
    );

    // Apply only behind the verified coverage guard; otherwise the prompt file is left BYTE-IDENTICAL.
    if (apply) await writeText(ctx.paths.promptFile(r), tightened.replace(/\n*$/, "") + "\n");

    rows.push({ role: r, sizeBefore, sizeAfter, pctDelta, droppedNothing, applied: apply, skipped, skipReason: reason, reviewPath });
  }
  return rows;
}
