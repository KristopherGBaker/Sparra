import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Paths } from "../src/paths.ts";
import { StateStore } from "../src/state.ts";
import { defaultConfig } from "../src/config.ts";
import type { Ctx } from "../src/context.ts";
import { roleRequestFromFlags } from "../src/phases/role.ts";

async function makeCtx(): Promise<{ ctx: Ctx; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-role-"));
  const paths = new Paths(dir);
  await paths.ensureScaffold();
  const store = StateStore.create(paths, "greenfield");
  const ctx: Ctx = { root: dir, paths, config: defaultConfig(), store };
  return { ctx, dir };
}

describe("roleRequestFromFlags — CLI --verify → allowVerify (H7 assertion 7d)", () => {
  it("--verify present as a real boolean → allowVerify: true", async () => {
    const { ctx, dir } = await makeCtx();
    const req = roleRequestFromFlags(ctx, "generator", { verify: true }, { briefText: "build" });
    expect(req.allowVerify).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("--verify absent → allowVerify falsy (today's default)", async () => {
    const { ctx, dir } = await makeCtx();
    const req = roleRequestFromFlags(ctx, "generator", {}, { briefText: "build" });
    expect(req.allowVerify).toBeFalsy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a stray --verify string (not a parsed boolean) does NOT set it true", async () => {
    const { ctx, dir } = await makeCtx();
    const req = roleRequestFromFlags(ctx, "generator", { verify: "true" }, { briefText: "build" });
    expect(req.allowVerify).toBeFalsy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("threads the other flags through (sanity — not just allowVerify)", async () => {
    const { ctx, dir } = await makeCtx();
    const req = roleRequestFromFlags(
      ctx,
      "generator",
      { workspace: "/ws", backend: "codex", model: "m" },
      { briefText: "build" }
    );
    expect(req.roleKind).toBe("generator");
    expect(req.workspace).toBe("/ws");
    expect(req.backend).toBe("codex");
    expect(req.model).toBe("m");
    expect(req.brief).toBe("build");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
