import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeOutCapture } from "../src/build/outCapture.ts";
import { negotiateContract } from "../src/build/contract.ts";
import { runRole } from "../src/build/roleRun.ts";
import type { CommandExecutor } from "../src/build/exec.ts";
import { Paths } from "../src/paths.ts";
import { StateStore } from "../src/state.ts";
import { defaultConfig } from "../src/config.ts";
import { DEFAULT_PROMPTS } from "../src/prompts.ts";
import type { Ctx } from "../src/context.ts";
import type { RunResult, RunSessionParams } from "../src/sdk/session.ts";

async function makeCtx(prefix: string): Promise<{ ctx: Ctx; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const paths = new Paths(dir);
  await paths.ensureScaffold();
  const store = StateStore.create(paths, "greenfield");
  const ctx: Ctx = { root: dir, paths, config: defaultConfig(), store };
  return { ctx, dir };
}

function captureStdout() {
  // The logger is silenced under vitest; both call sites assert on its output, so lift the
  // gate via the documented escape hatch while capturing and restore prior env on cleanup.
  const priorLogInTests = process.env.SPARRA_LOG_IN_TESTS;
  process.env.SPARRA_LOG_IN_TESTS = "1";
  let buf = "";
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    buf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  });
  return {
    lines: () => buf,
    restore: () => {
      spy.mockRestore();
      if (priorLogInTests === undefined) delete process.env.SPARRA_LOG_IN_TESTS;
      else process.env.SPARRA_LOG_IN_TESTS = priorLogInTests;
    },
  };
}

function runResult(resultText: string): RunResult {
  return {
    ok: true,
    subtype: "success",
    resultText,
    sessionId: "s",
    costUsd: 0,
    tokens: 1,
    numTurns: 1,
    hitMaxTurns: false,
    hitBudget: false,
    errors: [],
    tracePath: "",
  };
}

describe("normalizeOutCapture", () => {
  it("strips conversational preamble before the first markdown heading", () => {
    expect(normalizeOutCapture("Here's my result.\n\n# Report\nbody\n")).toEqual({
      text: "# Report\nbody\n",
      strippedPreamble: true,
      headingFound: true,
    });
  });

  it("leaves heading-first markdown unchanged apart from canonical trailing newline", () => {
    expect(normalizeOutCapture("## Findings\n- x\n").text).toBe("## Findings\n- x\n");
  });

  it("keeps heading-less input non-empty as trimmed raw text and warns", () => {
    const out = captureStdout();
    const result = normalizeOutCapture("  plain result\n\n  ");
    out.restore();

    expect(result).toEqual({
      text: "plain result\n",
      strippedPreamble: false,
      headingFound: false,
    });
    expect(out.lines()).toMatch(/no markdown heading/i);
  });

  it("keeps everything from the first heading through later headings and prose", () => {
    const raw = "ok\n\n## First\nbody\n\nSome prose.\n\n### Later\nmore\n";
    expect(normalizeOutCapture(raw).text).toBe("## First\nbody\n\nSome prose.\n\n### Later\nmore\n");
  });

  it("ignores markdown-looking headings inside fenced code blocks", () => {
    const raw = "Preamble.\n```md\n# Not the artifact\n```\nStill preamble.\n\n# Real\nbody\n";
    expect(normalizeOutCapture(raw).text).toBe("# Real\nbody\n");
  });
});

describe("out capture integration", () => {
  it("runRole non-evaluator out starts at the first heading", async () => {
    const { ctx, dir } = await makeCtx("sparra-out-rr-");
    const outFile = path.join(dir, "out.md");
    const fn = async (): Promise<RunResult> => runResult("Sure! Here's the doc.\n\n## Findings\n- x");

    await runRole({ ctx, roleKind: "contract-generator", brief: "write doc", out: outFile, runSessionFn: fn });

    expect(fs.readFileSync(outFile, "utf8")).toBe("## Findings\n- x\n");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("runRole non-evaluator heading-less out writes trimmed raw text and warns", async () => {
    const { ctx, dir } = await makeCtx("sparra-out-rr-");
    const outFile = path.join(dir, "out.md");
    const fn = async (): Promise<RunResult> => runResult("  plain result\n\n");
    const out = captureStdout();

    await runRole({ ctx, roleKind: "contract-generator", brief: "write doc", out: outFile, runSessionFn: fn });
    out.restore();

    expect(fs.readFileSync(outFile, "utf8")).toBe("plain result\n");
    expect(out.lines()).toMatch(/no markdown heading/i);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("runRole evaluator out still writes the verdict template", async () => {
    const { ctx, dir } = await makeCtx("sparra-out-rr-");
    const outFile = path.join(dir, "verdict.md");
    const verdict =
      '```json\n{"assertions":[{"id":1,"pass":true,"evidence":"ok"}],"scores":{"design":90,"originality":90,"craft":90,"functionality":90},"verdict":"pass","blocking":[],"notes":"n"}\n```';
    const fn = async (): Promise<RunResult> => runResult(`Preamble before JSON.\n\n${verdict}`);

    await runRole({ ctx, roleKind: "evaluator", brief: "grade", out: outFile, runSessionFn: fn });

    expect(fs.readFileSync(outFile, "utf8").startsWith("# Verdict — evaluator")).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("negotiateContract captures proposal text from the first heading", async () => {
    const { ctx, dir } = await makeCtx("sparra-out-contract-");
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-out-contract-wt-"));
    const item = { id: "item-001", title: "thing", summary: "s", dependsOn: [], rationale: "" };
    const proposal = "File writes are blocked, so proposing inline.\n\n## Item\nThing.\n## Assertions\n1. works";
    const calls: RunSessionParams[] = [];
    const fn = async (p: RunSessionParams): Promise<RunResult> => {
      calls.push(p);
      return runResult(p.role === "contract-generator" ? proposal : "CONTRACT: AGREED");
    };
    const exec = vi.fn<CommandExecutor>(async () => ({ ran: false, command: "", unsafeReason: "unused" }));

    const res = await negotiateContract(ctx, item, wt, 1, "", wt, fn, exec);
    const contractFile = fs.readFileSync(ctx.paths.contractFile(item.id), "utf8");
    const agreedSection = contractFile.split("## AGREED CONTRACT")[1]!.trim();

    expect(res.text).toBe("## Item\nThing.\n## Assertions\n1. works");
    expect(agreedSection).toContain("## Item\nThing.");
    expect(agreedSection).not.toContain("File writes are blocked");
    expect(calls.filter((c) => c.role === "contract-generator")).toHaveLength(1);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(wt, { recursive: true, force: true });
  });
});

describe("contract-generator prompt", () => {
  it("tells the role to start at the first heading with no preamble", () => {
    const prompt = DEFAULT_PROMPTS["contract-generator"]!;
    expect(prompt).toMatch(/starting at the first heading/i);
    expect(prompt).toMatch(/no preamble/i);
    expect(prompt).toMatch(/output becomes the file verbatim/i);
  });
});
