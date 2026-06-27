import { describe, expect, it } from "vitest";
import path from "node:path";
import { Paths } from "../src/paths.ts";

describe("Paths docsDir", () => {
  const root = "/tmp/proj";

  it("keeps human-facing docs at the root by default", () => {
    const p = new Paths(root);
    expect(p.docsBase).toBe(root);
    expect(p.plan).toBe(path.join(root, "PLAN.md"));
    expect(p.changelog).toBe(path.join(root, "CHANGELOG.md"));
    expect(p.codebaseMap).toBe(path.join(root, "CODEBASE_MAP.md"));
    expect(p.holdout).toBe(path.join(root, "HOLDOUT.md"));
  });

  it("relocates the human-facing docs under docsDir when set", () => {
    const p = new Paths(root, "docs");
    expect(p.docsBase).toBe(path.join(root, "docs"));
    expect(p.plan).toBe(path.join(root, "docs", "PLAN.md"));
    expect(p.changelog).toBe(path.join(root, "docs", "CHANGELOG.md"));
    expect(p.codebaseMap).toBe(path.join(root, "docs", "CODEBASE_MAP.md"));
    expect(p.holdout).toBe(path.join(root, "docs", "HOLDOUT.md"));
  });

  it("leaves .sparra machinery at the root regardless of docsDir", () => {
    const p = new Paths(root, "docs");
    expect(p.dir).toBe(path.join(root, ".sparra"));
    expect(p.config).toBe(path.join(root, ".sparra", "config.yaml"));
    expect(p.state).toBe(path.join(root, ".sparra", "state.json"));
  });
});
