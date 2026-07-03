import { describe, it, expect } from "vitest";
import {
  classifyExerciseExit,
  exerciseStatusFromObservations,
  buildExerciser,
  type Exerciser,
} from "../src/sdk/exercise.ts";
import { defaultConfig } from "../src/config.ts";

/** Drive the REAL run_command handler the evaluator would call — through the registered MCP tool,
 *  not a recording shortcut. The handler is stored on the McpServer instance built by buildExerciser. */
async function callRunCommand(ex: Exerciser, command: string): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const server = ex.mcpServers.exercise as any;
  const reg = server.instance._registeredTools.run_command;
  const res = await reg.handler({ command }, {});
  return res.content.map((c: { text: string }) => c.text).join("\n");
}

describe("classifyExerciseExit — deterministic block vs ran (precedence)", () => {
  it("exit 0 ⇒ ran (ignores stderr, even a block signature)", () => {
    expect(classifyExerciseExit({ code: 0, stderr: "", timedOut: false })).toBe("ran");
    expect(classifyExerciseExit({ code: 0, stderr: "permission denied", timedOut: false })).toBe("ran");
  });

  it("timeout ⇒ ran, checked BEFORE the code===-1 rule", () => {
    // A SIGKILL'd timeout surfaces code -1 in runShell; timedOut must win → ran.
    expect(classifyExerciseExit({ code: -1, stderr: "", timedOut: true })).toBe("ran");
    expect(classifyExerciseExit({ code: 137, stderr: "", timedOut: true })).toBe("ran");
  });

  it("code 127 ⇒ blocked (shell couldn't find the command)", () => {
    expect(classifyExerciseExit({ code: 127, stderr: "", timedOut: false })).toBe("blocked");
  });

  it("code -1 (spawn) ⇒ blocked IFF stderr has a spawn-error signature, else ran", () => {
    expect(classifyExerciseExit({ code: -1, stderr: "Error: spawn EPERM", timedOut: false })).toBe("blocked");
    expect(classifyExerciseExit({ code: -1, stderr: "some other failure", timedOut: false })).toBe("ran");
  });

  it("code≠0 + a block signature ⇒ blocked (case-insensitive, only the named set)", () => {
    for (const sig of ["command not found", "EPERM", "operation not permitted", "permission denied", "requires approval"]) {
      expect(classifyExerciseExit({ code: 1, stderr: `bash: ${sig}`, timedOut: false })).toBe("blocked");
      expect(classifyExerciseExit({ code: 1, stderr: sig.toUpperCase(), timedOut: false })).toBe("blocked");
    }
  });

  it("a command that executed and FAILED ⇒ ran", () => {
    expect(classifyExerciseExit({ code: 1, stderr: "AssertionError", timedOut: false })).toBe("ran");
    expect(classifyExerciseExit({ code: 2, stderr: "usage: ...", timedOut: false })).toBe("ran");
  });

  it("exit 1 + 'no such file or directory' ⇒ ran (NOT in the block set — too broad)", () => {
    expect(classifyExerciseExit({ code: 1, stderr: "cat: x: No such file or directory", timedOut: false })).toBe("ran");
    // bare "not permitted" and "sandbox" are also excluded
    expect(classifyExerciseExit({ code: 1, stderr: "operation was not permitted somewhere", timedOut: false })).toBe("ran");
    expect(classifyExerciseExit({ code: 1, stderr: "ran in a sandbox", timedOut: false })).toBe("ran");
  });
});

describe("exerciseStatusFromObservations — aggregator", () => {
  it("all blocked ⇒ blocked", () => {
    expect(exerciseStatusFromObservations(["blocked"])).toBe("blocked");
    expect(exerciseStatusFromObservations(["blocked", "blocked"])).toBe("blocked");
  });
  it("ran + blocked ⇒ mixed", () => {
    const status = exerciseStatusFromObservations(["ran", "blocked", "ran"]);
    expect(status).toBe("mixed");
    expect(status).not.toBe("blocked");
    expect(status).not.toBe("ran");
  });
  it("≥1 obs, none blocked ⇒ ran", () => {
    expect(exerciseStatusFromObservations(["ran", "ran"])).toBe("ran");
  });
  it("no obs ⇒ none", () => {
    expect(exerciseStatusFromObservations([])).toBe("none");
  });
});

describe("Exerciser — records via the REAL run_command handler", () => {
  it("starts at none, records a missing binary as blocked (127)", async () => {
    const ex = buildExerciser(defaultConfig(), "/tmp");
    expect(ex.exerciseStatus()).toBe("none");
    const text = await callRunCommand(ex, "this-binary-does-not-exist-xyz");
    expect(text).toContain("[exit code:"); // model-facing text unchanged
    expect(ex.exerciseStatus()).toBe("blocked");
  });

  it("records a real successful command as ran", async () => {
    const ex = buildExerciser(defaultConfig(), "/tmp");
    await callRunCommand(ex, "echo hi");
    expect(ex.exerciseStatus()).toBe("ran");
    const ex2 = buildExerciser(defaultConfig(), "/tmp");
    await callRunCommand(ex2, "true");
    expect(ex2.exerciseStatus()).toBe("ran");
  });

  it("an executed-but-failed command (exit 1) is ran, not blocked", async () => {
    const ex = buildExerciser(defaultConfig(), "/tmp");
    const text = await callRunCommand(ex, "sh -c 'exit 1'");
    expect(text).toContain("[exit code: 1]");
    expect(ex.exerciseStatus()).toBe("ran");
  });

  it("ran plus blocked across multiple commands returns mixed", async () => {
    const ex = buildExerciser(defaultConfig(), "/tmp");
    await callRunCommand(ex, "echo ok");
    await callRunCommand(ex, "this-binary-does-not-exist-xyz");
    expect(ex.exerciseStatus()).toBe("mixed");
  });
});
