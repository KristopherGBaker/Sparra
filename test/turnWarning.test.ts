import { describe, it, expect, vi } from "vitest";
import os from "node:os";
import {
  makeReportTurnWarningHook,
  hasReportTurnWarningHook,
  reportTurnWarningText,
  MIN_TURNS_FOR_WARNING,
  TURN_WARNING_RATIO,
} from "../src/sdk/turnWarning.ts";
import type { HookConfig } from "../src/sdk/hooks.ts";
import type { AgentRequest } from "../src/sdk/backend.ts";

// Codex CLI stub so runTask never spawns the real CLI (mirrors test/backend.test.ts).
const codexCapture = vi.hoisted(() => ({ threadOptions: undefined as any }));
vi.mock("@openai/codex-sdk", () => ({
  Codex: class {
    id = "codex-thread";
    startThread(opts: any) {
      codexCapture.threadOptions = opts;
      return { id: "codex-thread", run: async () => ({ usage: { total_tokens: 1 }, finalResponse: "ok" }) };
    }
    resumeThread(_id: string, opts: any) {
      return this.startThread(opts);
    }
  },
}));

/** Invoke the (single) PostToolUse warning hook and return its output. */
async function firePostToolUse(hooks: HookConfig): Promise<any> {
  const cb = hooks.PostToolUse![0]!.hooks[0]!;
  return cb({ hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: {} } as any, "id", {} as any);
}

/** Advance the progress counter by feeding `n` assistant-text events. */
function advance(onAssistantText: (t: string) => void, n: number) {
  for (let i = 0; i < n; i++) onAssistantText(`turn ${i}`);
}

describe("makeReportTurnWarningHook — progress from the onAssistantText seam (assertion 1)", () => {
  it("advances the counter from onAssistantText AND still invokes a caller-supplied hook", async () => {
    const seen: string[] = [];
    const seam = makeReportTurnWarningHook({ maxTurns: 60, onAssistantText: (t) => seen.push(t) });

    // 47 events: below the 80% threshold (floor(60*0.8)=48) — no warning yet.
    advance(seam.onAssistantText, 47);
    expect(await firePostToolUse(seam.hooks)).toEqual({});
    // Caller's onAssistantText was invoked for every event (wrapped, not replaced).
    expect(seen).toHaveLength(47);
    expect(seen[0]).toBe("turn 0");

    // The 48th event crosses the threshold — the counter is genuinely driven by onAssistantText.
    advance(seam.onAssistantText, 1);
    const out = await firePostToolUse(seam.hooks);
    expect(out.hookSpecificOutput?.additionalContext).toBeTruthy();
    expect(seen).toHaveLength(48);
  });

  it("works with no caller-supplied onAssistantText (still counts)", async () => {
    const seam = makeReportTurnWarningHook({ maxTurns: 60 });
    advance(seam.onAssistantText, 48);
    expect((await firePostToolUse(seam.hooks)).hookSpecificOutput?.additionalContext).toBeTruthy();
  });
});

describe("~80% crossing returns additionalContext naming remaining turns + report (assertion 2)", () => {
  it("for maxTurns=60 fires around turn 48 with ~12 remaining and a 'report JSON now' instruction", async () => {
    const seam = makeReportTurnWarningHook({ maxTurns: 60 });
    advance(seam.onAssistantText, Math.floor(60 * TURN_WARNING_RATIO)); // 48
    const out = await firePostToolUse(seam.hooks);
    expect(out.hookSpecificOutput?.hookEventName).toBe("PostToolUse");
    const text: string = out.hookSpecificOutput.additionalContext;
    expect(text).toContain("12"); // 60 - 48 remaining
    expect(text.toLowerCase()).toContain("report");
    expect(text.toLowerCase()).toContain("json");
    expect(text.toLowerCase()).toContain("now");
  });

  it("reportTurnWarningText names the count and singularizes correctly", () => {
    expect(reportTurnWarningText(12)).toContain("12 turns");
    expect(reportTurnWarningText(1)).toContain("1 turn ");
  });
});

describe("fires AT MOST ONCE per session (assertion 3)", () => {
  it("returns no payload after the first injection", async () => {
    const seam = makeReportTurnWarningHook({ maxTurns: 60 });
    advance(seam.onAssistantText, 48);
    expect((await firePostToolUse(seam.hooks)).hookSpecificOutput?.additionalContext).toBeTruthy();
    // Later checks — even as progress keeps climbing — return nothing.
    advance(seam.onAssistantText, 10);
    expect(await firePostToolUse(seam.hooks)).toEqual({});
    expect(await firePostToolUse(seam.hooks)).toEqual({});
  });

  it("two separate session instances each fire once, independently", async () => {
    const a = makeReportTurnWarningHook({ maxTurns: 60 });
    const b = makeReportTurnWarningHook({ maxTurns: 60 });
    advance(a.onAssistantText, 48);
    expect((await firePostToolUse(a.hooks)).hookSpecificOutput?.additionalContext).toBeTruthy();
    // b has its own counter — a's firing doesn't affect it.
    expect(await firePostToolUse(b.hooks)).toEqual({});
    advance(b.onAssistantText, 48);
    expect((await firePostToolUse(b.hooks)).hookSpecificOutput?.additionalContext).toBeTruthy();
  });
});

describe("no warning below the floor / when maxTurns unset or 0 (assertion 4)", () => {
  it("attaches no hook when maxTurns is unset or 0", () => {
    expect(makeReportTurnWarningHook({}).hooks.PostToolUse).toBeUndefined();
    expect(makeReportTurnWarningHook({ maxTurns: 0 }).hooks.PostToolUse).toBeUndefined();
    expect(hasReportTurnWarningHook(makeReportTurnWarningHook({}).hooks)).toBe(false);
  });

  it(`is DISABLED below the floor (maxTurns=8 < MIN_TURNS_FOR_WARNING=${MIN_TURNS_FOR_WARNING})`, async () => {
    const seam = makeReportTurnWarningHook({ maxTurns: 8 });
    expect(seam.hooks.PostToolUse).toBeUndefined();
    // The counter still advances (uniform wiring) but there is no hook to fire.
    advance(seam.onAssistantText, 8);
    expect(hasReportTurnWarningHook(seam.hooks)).toBe(false);
  });

  it("is ENABLED exactly at the floor (maxTurns=10) — floor tested directly", async () => {
    expect(MIN_TURNS_FOR_WARNING).toBe(10);
    const seam = makeReportTurnWarningHook({ maxTurns: 10 });
    expect(hasReportTurnWarningHook(seam.hooks)).toBe(true);
    // threshold = floor(10*0.8) = 8: 7 events no warning, the 8th fires.
    advance(seam.onAssistantText, 7);
    expect(await firePostToolUse(seam.hooks)).toEqual({});
    advance(seam.onAssistantText, 1);
    expect((await firePostToolUse(seam.hooks)).hookSpecificOutput?.additionalContext).toBeTruthy();
  });
});

describe("Codex / hooks:false backend is unaffected (assertion 7)", () => {
  it("codex capability seam declares hooks:false, so the Claude-only warning never attaches", async () => {
    const { getBackend } = await import("../src/sdk/backend.ts");
    await import("../src/sdk/session.ts"); // registers claude + codex
    expect(getBackend("codex").capabilities.hooks).toBe(false);
  });

  it("codex.runTask does NOT throw when handed a request carrying the warning hooks (it ignores them)", async () => {
    const { codexBackend } = await import("../src/sdk/backends/codex.ts");
    const seam = makeReportTurnWarningHook({ maxTurns: 60 });
    codexCapture.threadOptions = undefined;
    const req: AgentRequest = {
      role: "generator",
      prompt: "p",
      systemPrompt: "s",
      model: "m",
      cwd: os.tmpdir(),
      backend: "codex",
      writeScope: [os.tmpdir()],
      hooks: seam.hooks, // Claude-shaped; codex must ignore, not choke
      onAssistantText: seam.onAssistantText,
      traceDir: os.tmpdir(),
      traceSeq: 1,
      echoActivity: false,
    };
    // Resolves (never throws) even though the request carries Claude-shaped hooks.
    const r = await codexBackend.runTask(req);
    expect(r).toBeTruthy();
    // The backend actually ran (built ThreadOptions) yet those options never carry a `hooks`
    // field — codex has no interception seam, so the warning is inert by construction.
    expect(codexCapture.threadOptions).toBeDefined();
    expect(codexCapture.threadOptions?.hooks).toBeUndefined();
  });
});
