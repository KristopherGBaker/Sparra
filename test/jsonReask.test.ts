import { describe, it, expect } from "vitest";
import {
  reportReaskOverrides,
  REPORT_REASK_PROMPT,
  REPORT_REASK_MAX_TURNS,
} from "../src/build/jsonReask.ts";

describe("reportReaskOverrides", () => {
  const base = { role: "role-run-generator-reask", sessionId: "sess-1" };

  it("(#1) tightCap forces a TEXT-ONLY turn: readOnly + plan + cleared writer hooks, tightly capped", () => {
    const o = reportReaskOverrides({ ...base, tightCap: { maxBudgetUsd: 0.3 } });
    // report-only resume plumbing
    expect(o.role).toBe(base.role);
    expect(o.resume).toBe("sess-1");
    expect(o.prompt).toBe(REPORT_REASK_PROMPT);
    // tight cap
    expect(o.maxTurns).toBe(REPORT_REASK_MAX_TURNS);
    expect(o.maxBudgetUsd).toBe(0.3);
    // text-only: the fields that override the inherited writer state so writes can't happen
    expect(o.readOnly).toBe(true);
    expect(o.permissionMode).toBe("plan");
    expect("hooks" in o).toBe(true); // present so it WINS over an inherited writer `hooks`…
    expect(o.hooks).toBeUndefined(); // …clearing them → the Claude backend derives read-only hooks
  });

  it("(#3) NO tightCap → the autonomous path is unchanged: none of readOnly/permissionMode/hooks/maxTurns/maxBudgetUsd", () => {
    const o = reportReaskOverrides(base);
    expect(o.role).toBe(base.role);
    expect(o.resume).toBe("sess-1");
    expect(o.prompt).toBe(REPORT_REASK_PROMPT);
    // none of the tightCap-only fields leak into the autonomous (generate.ts) re-ask
    expect("readOnly" in o).toBe(false);
    expect("permissionMode" in o).toBe(false);
    expect("hooks" in o).toBe(false);
    expect("maxTurns" in o).toBe(false);
    expect("maxBudgetUsd" in o).toBe(false);
  });
});
