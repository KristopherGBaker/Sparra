import { describe, it, expect } from "vitest";
import {
  reportReaskOverrides,
  reaskBudgetUsd,
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

  // The clamp is a CEILING, not a "materially tighter than the dying run" guarantee. On a BUDGET-cap
  // death observedCostUsd ≈ runCapUsd, so the re-ask is handed the run's FULL cap — pinned here so the
  // honest behavior is asserted rather than left to a roomy-cap case that hides it. Real spend stays
  // bounded by reportReaskOverrides' tightCap (1 turn, text-only), NOT by this number.
  it("on a budget-cap death (observed ≈ cap) it returns the run's full cap — a ceiling, never more", () => {
    expect(reaskBudgetUsd(5, 5)).toBe(5);
    expect(reaskBudgetUsd(4.9, 5)).toBe(5);
    // …and never exceeds it, however hot the dying run ran.
    expect(reaskBudgetUsd(50, 5)).toBe(5);
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
