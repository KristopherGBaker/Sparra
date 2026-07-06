import { describe, it, expect } from "vitest";
import {
  reportReaskOverrides,
  REPORT_REASK_PROMPT,
  REPORT_REASK_MAX_TURNS,
} from "../src/build/jsonReask.ts";

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
