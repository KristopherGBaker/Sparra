import { describe, it, expect } from "vitest";
import {
  reportReaskOverrides,
  reaskBudgetUsd,
  reaskOverageNote,
  effectiveBudgetCeilingUsd,
  REASK_MAX_BUDGET_USD,
  REPORT_REASK_PROMPT,
  REPORT_REASK_MAX_TURNS,
  VERDICT_REASK_PROMPT,
} from "../src/build/jsonReask.ts";

// Real-world evidence the floor must clear: a single observed opus turn cost this much
// (trace 2026-07-13T07-52-03) and died under the old blind $0.5 cap.
const OBSERVED_OPUS_TURN_USD = 1.5775;

describe("reaskBudgetUsd", () => {
  it("floors at a value that covers one expensive (opus) turn even with zero/absent observed cost", () => {
    expect(reaskBudgetUsd(0, 0)).toBeGreaterThan(OBSERVED_OPUS_TURN_USD);
  });

  it("never exceeds the dying run's own (constrained) cap", () => {
    const capped = reaskBudgetUsd(OBSERVED_OPUS_TURN_USD, 1);
    expect(capped).toBeGreaterThan(0);
    expect(capped).toBeLessThanOrEqual(1);
  });

  it("a roomy run cap covers the observed expensive turn while staying materially tighter than the run", () => {
    const roomy = reaskBudgetUsd(OBSERVED_OPUS_TURN_USD, 25);
    expect(roomy).toBeGreaterThan(OBSERVED_OPUS_TURN_USD);
    expect(roomy).toBeLessThan(25);
  });

  // Field report 2026-09-14/15: a $12-capped generator finished at $14.43 and a $14-capped one at
  // $16.78, both via the post-cap re-ask. On a budget-cap death observedCostUsd ≈ runCapUsd, so
  // observed*margin cleared the cap and the clamp handed the re-ask the run's WHOLE cap again —
  // an authorized ceiling of cap+cap on exactly the runs that already spent the most.
  it("on a budget-cap death (observed ≈ cap) the re-ask never scales with the run — bounded absolutely", () => {
    expect(reaskBudgetUsd(12, 12)).toBe(REASK_MAX_BUDGET_USD); // was 12 (the whole cap, twice over)
    expect(reaskBudgetUsd(14, 14)).toBe(REASK_MAX_BUDGET_USD);
    expect(reaskBudgetUsd(500, 500)).toBe(REASK_MAX_BUDGET_USD); // however hot the dying run ran
  });

  it("a cap TIGHTER than the absolute max still clamps to the cap (never authorizes more than the run)", () => {
    expect(reaskBudgetUsd(5, 5)).toBe(Math.min(REASK_MAX_BUDGET_USD, 5));
    expect(reaskBudgetUsd(50, 3)).toBe(3);
  });

  it("the absolute max still clears one expensive (opus) turn — recovery stays possible", () => {
    expect(REASK_MAX_BUDGET_USD).toBeGreaterThan(OBSERVED_OPUS_TURN_USD);
  });
});

describe("effectiveBudgetCeilingUsd / reaskOverageNote — the cap is a PRE-re-ask ceiling", () => {
  it("states the number a caller should size for: cap + the bounded re-ask", () => {
    expect(effectiveBudgetCeilingUsd(12)).toBe(12 + REASK_MAX_BUDGET_USD);
    // A cap tighter than the re-ask max can at worst double, never more.
    expect(effectiveBudgetCeilingUsd(2)).toBe(4);
    expect(effectiveBudgetCeilingUsd(0)).toBe(0); // unlimited stays unlimited
  });

  it("the overage note names the spend, the authorization, the cap and the real ceiling", () => {
    const note = reaskOverageNote(2.43, 4, 12);
    expect(note).toContain("$2.43");
    expect(note).toContain("$4.00");
    expect(note).toContain("$12.00");
    expect(note).toContain("$16.00"); // effective ceiling
    expect(note).toContain("jsonReask");
  });

  it("no cap means nothing to overshoot — no note", () => {
    expect(reaskOverageNote(2.43, 4, 0)).toBe("");
  });

  it("runCapUsd 0 means unlimited (existing Sparra semantics) — no clamp toward 0", () => {
    expect(reaskBudgetUsd(OBSERVED_OPUS_TURN_USD, 0)).toBeGreaterThan(OBSERVED_OPUS_TURN_USD);
  });

  it("a negative/NaN observed cost is treated as zero, not laundered into a negative/NaN budget", () => {
    expect(reaskBudgetUsd(-5, 0)).toBeGreaterThan(0);
    expect(Number.isNaN(reaskBudgetUsd(NaN, 0))).toBe(false);
  });
});

describe("reportReaskOverrides", () => {
  const base = { role: "role-run-generator-reask", sessionId: "sess-1" };

  it("(#1) tightCap forces a genuinely TEXT-ONLY turn: tools stripped, no plan mode, readOnly, cleared writer hooks+mcp, tightly capped", () => {
    const o = reportReaskOverrides({ ...base, tightCap: { maxBudgetUsd: 0.3 } });
    // report-only resume plumbing
    expect(o.role).toBe(base.role);
    expect(o.resume).toBe("sess-1");
    expect(o.prompt).toBe(REPORT_REASK_PROMPT);
    // tight cap
    expect(o.maxTurns).toBe(REPORT_REASK_MAX_TURNS);
    expect(o.maxBudgetUsd).toBe(0.3);
    // tool-stripping: empty tools array → Claude has no built-in tools to invoke (no Write/Edit/Bash)
    expect(o.tools).toEqual([]);
    // no plan mode: plan mode's prompt invited a plan-file Write that the sandbox blocked,
    // burning the single turn; tool-stripping is the correct write-block instead.
    expect(o.permissionMode).toBe("default");
    // read-only Codex sandbox intent preserved
    expect(o.readOnly).toBe(true);
    // cleared writer hooks → the Claude backend derives read-only hooks from readOnly
    expect("hooks" in o).toBe(true);
    expect(o.hooks).toBeUndefined();
    // cleared MCP / allowedTools: a text-only re-emit needs no MCP tools
    expect("mcpServers" in o).toBe(true);
    expect(o.mcpServers).toBeUndefined();
    expect("allowedTools" in o).toBe(true);
    expect(o.allowedTools).toBeUndefined();
  });

  it("prompt override → the evaluator verdict re-ask uses VERDICT_REASK_PROMPT (shared literal, not a roleRun fork)", () => {
    const o = reportReaskOverrides({ ...base, role: "role-run-evaluator-reask", tightCap: { maxBudgetUsd: 0.5 }, prompt: VERDICT_REASK_PROMPT });
    expect(o.prompt).toBe(VERDICT_REASK_PROMPT);
    expect(VERDICT_REASK_PROMPT).toContain("Re-emit ONLY the JSON verdict block");
    expect(VERDICT_REASK_PROMPT).not.toBe(REPORT_REASK_PROMPT); // verdict-specific, not the generator report prompt
    // still a genuinely text-only tightCap turn
    expect(o.tools).toEqual([]);
    expect(o.readOnly).toBe(true);
    expect(o.maxTurns).toBe(REPORT_REASK_MAX_TURNS);
  });

  it("(#5) NO tightCap → exactly {role, prompt, resume}: none of the tightCap-only keys present", () => {
    const o = reportReaskOverrides(base);
    // exact enumerable key set
    expect(Object.keys(o)).toEqual(["role", "prompt", "resume"]);
    // spot-check values
    expect(o.role).toBe(base.role);
    expect(o.resume).toBe("sess-1");
    expect(o.prompt).toBe(REPORT_REASK_PROMPT);
    // no tightCap-only fields leak into the base re-ask
    const tightCapKeys = ["tools", "readOnly", "permissionMode", "hooks", "maxTurns", "maxBudgetUsd", "mcpServers", "allowedTools"];
    for (const k of tightCapKeys) {
      expect(k in o, `${k} must not be present in the no-tightCap object`).toBe(false);
    }
  });
});
