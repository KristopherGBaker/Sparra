import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chooseFormatter, runFormatter, makeFormatHook, type FormatOptions } from "../src/sdk/format.ts";

const base: FormatOptions = { enabled: true, command: "", autodetect: true, mode: "greenfield", codebaseMap: null };

/** A `fileExists` seam that reports the named config file(s) as present at every level up-tree (i.e.
 *  "discoverable"); any other probe is absent. Deterministic — no real filesystem. */
function hasConfig(names: string[]): (p: string) => boolean {
  return (p: string) => names.includes(path.basename(p));
}

/** Create a temp workspace; optionally drop a `.swiftformat` config at a chosen dir. */
function swiftWorkspace(opts: { config?: "root" | "none" } = {}): { ws: string; file: string } {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "fmt-cfg-"));
  const sub = path.join(ws, "Sources", "App");
  fs.mkdirSync(sub, { recursive: true });
  const file = path.join(sub, "View.swift");
  fs.writeFileSync(file, "struct V {}\n");
  if (opts.config === "root") fs.writeFileSync(path.join(ws, ".swiftformat"), "--indent 4\n");
  return { ws, file };
}

describe("chooseFormatter", () => {
  it("uses an explicit command with {file} substitution", () => {
    expect(chooseFormatter("/x/a.ts", { ...base, command: "myfmt --write {file}" })).toEqual([
      "myfmt",
      "--write",
      "/x/a.ts",
    ]);
  });

  it("appends the file when the explicit command has no placeholder", () => {
    expect(chooseFormatter("/x/a.ts", { ...base, command: "myfmt" })).toEqual(["myfmt", "/x/a.ts"]);
  });

  it("resolves a prettier-style formatter for TS/JS ONLY when a prettier config is discoverable", () => {
    // No prettier config anywhere ⇒ no autodetected formatting (new H4 rule; was prettier before).
    expect(chooseFormatter("/x/a.ts", base, { fileExists: () => false })).toBeNull();
    expect(chooseFormatter("/x/a.css", base, { fileExists: () => false })).toBeNull();
    // A discoverable .prettierrc up-tree ⇒ prettier resolves.
    expect(chooseFormatter("/x/a.ts", base, { fileExists: hasConfig([".prettierrc"]) })).toEqual(["prettier", "--write", "/x/a.ts"]);
  });

  it("detects swiftformat from CODEBASE_MAP.md for existing iOS repos WHEN a .swiftformat config exists", () => {
    const { ws, file } = swiftWorkspace({ config: "root" });
    const opts: FormatOptions = { ...base, mode: "existing", codebaseMap: "We use SwiftFormat and SwiftLint.", workspaceRoot: ws };
    expect(chooseFormatter(file, opts)).toEqual(["swiftformat", file]);
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it("prefers swiftlint --fix when the map mentions only swiftlint (a linter, not config-gated)", () => {
    const opts: FormatOptions = { ...base, mode: "existing", codebaseMap: "Linting via swiftlint only." };
    expect(chooseFormatter("/x/View.swift", opts)).toEqual(["swiftlint", "--fix", "/x/View.swift"]);
  });

  it("returns null for an unknown extension", () => {
    expect(chooseFormatter("/x/data.bin", base)).toBeNull();
  });

  it("returns null when autodetect is off and no command is set", () => {
    expect(chooseFormatter("/x/a.ts", { ...base, autodetect: false })).toBeNull();
  });
});

describe("chooseFormatter — autodetect requires a discoverable config (H4)", () => {
  it("(a) autodetect swiftformat + NO .swiftformat anywhere ⇒ no command resolved", () => {
    const { ws, file } = swiftWorkspace({ config: "none" });
    expect(chooseFormatter(file, { ...base, workspaceRoot: ws })).toBeNull();
    // ...and the same in 'existing' mode even when the map names swiftformat (autodetect, not opt-in).
    expect(chooseFormatter(file, { ...base, mode: "existing", codebaseMap: "Uses SwiftFormat.", workspaceRoot: ws })).toBeNull();
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it("(b) autodetect + a .swiftformat in an ANCESTOR/workspace-root dir ⇒ swiftformat resolved", () => {
    const { ws, file } = swiftWorkspace({ config: "root" }); // config sits at the root; file is nested
    expect(chooseFormatter(file, { ...base, workspaceRoot: ws })).toEqual(["swiftformat", file]);
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it("(b2) a .swiftformat in an unrelated SIBLING subtree does NOT count (only ancestors are searched)", () => {
    const { ws, file } = swiftWorkspace({ config: "none" });
    const sibling = path.join(ws, "Other");
    fs.mkdirSync(sibling, { recursive: true });
    fs.writeFileSync(path.join(sibling, ".swiftformat"), "--indent 4\n"); // sibling of Sources/, not an ancestor
    expect(chooseFormatter(file, { ...base, workspaceRoot: ws })).toBeNull();
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it("(c) an explicit format.command ALWAYS resolves regardless of config presence", () => {
    const { ws, file } = swiftWorkspace({ config: "none" });
    expect(chooseFormatter(file, { ...base, command: "swiftformat", workspaceRoot: ws })).toEqual(["swiftformat", file]);
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it("(d) format.enabled:false ⇒ the format hook is a no-op (nothing resolved/run)", () => {
    expect(makeFormatHook({ ...base, enabled: false })).toEqual({});
    expect(makeFormatHook({ ...base, enabled: true }).PostToolUse?.length).toBeGreaterThan(0);
  });
});

describe("chooseFormatter — the config gate applies to ALL autodetected formatters (not just swiftformat)", () => {
  // ext, the formatter's argv, and a config filename that satisfies its gate.
  const CASES: Array<{ name: string; file: string; cfg: string; argv: string[] }> = [
    { name: "prettier (.ts)", file: "/x/a.ts", cfg: ".prettierrc", argv: ["prettier", "--write", "/x/a.ts"] },
    { name: "prettier.config.js (.ts)", file: "/x/a.ts", cfg: "prettier.config.js", argv: ["prettier", "--write", "/x/a.ts"] },
    { name: "black (.py)", file: "/x/a.py", cfg: "pyproject.toml", argv: ["black", "/x/a.py"] },
    { name: "gofmt (.go)", file: "/x/a.go", cfg: "go.mod", argv: ["gofmt", "-w", "/x/a.go"] },
    { name: "rustfmt (.rs)", file: "/x/a.rs", cfg: "rustfmt.toml", argv: ["rustfmt", "/x/a.rs"] },
  ];

  for (const c of CASES) {
    it(`${c.name}: NO config ⇒ null, WITH config ⇒ resolves`, () => {
      expect(chooseFormatter(c.file, base, { fileExists: () => false })).toBeNull();
      expect(chooseFormatter(c.file, base, { fileExists: hasConfig([c.cfg]) })).toEqual(c.argv);
    });
  }

  it("a map-mentioned formatter is STILL config-gated (existing repo, no config ⇒ null)", () => {
    const opts: FormatOptions = { ...base, mode: "existing", codebaseMap: "We format with prettier." };
    expect(chooseFormatter("/x/a.ts", opts, { fileExists: () => false })).toBeNull();
    expect(chooseFormatter("/x/a.ts", opts, { fileExists: hasConfig([".prettierrc"]) })).toEqual(["prettier", "--write", "/x/a.ts"]);
  });

  it("an explicit format.command bypasses the gate for non-Swift files too", () => {
    expect(chooseFormatter("/x/a.ts", { ...base, command: "myfmt" }, { fileExists: () => false })).toEqual(["myfmt", "/x/a.ts"]);
  });
});

describe("runFormatter", () => {
  it("actually formats the touched file via the chosen formatter", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmt-"));
    const file = path.join(dir, "a.ts");
    fs.writeFileSync(file, "const   x=1\n\n\n\nconst y=2\n"); // deliberately mis-formatted
    const warnings: string[] = [];

    const result = runFormatter(
      file,
      { ...base, command: "fakefmt {file}" },
      {
        warn: (m) => warnings.push(m),
        exec: (argv) => {
          // simulate a real formatter rewriting the file in place
          const target = argv[argv.length - 1]!;
          const src = fs.readFileSync(target, "utf8");
          const formatted = src.replace(/ {2,}/g, " ").replace(/\n{3,}/g, "\n\n");
          fs.writeFileSync(target, formatted);
          return { status: 0 };
        },
      }
    );

    const after = fs.readFileSync(file, "utf8");
    expect(result.ran).toBe(true);
    expect(after).toBe("const x=1\n\nconst y=2\n");
    expect(warnings).toHaveLength(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("warns rather than throwing when the formatter is not installed (ENOENT)", () => {
    const warnings: string[] = [];
    let result: ReturnType<typeof runFormatter> | undefined;
    expect(() => {
      result = runFormatter("/x/a.ts", base, {
        warn: (m) => warnings.push(m),
        fileExists: hasConfig([".prettierrc"]), // config present so prettier resolves; the exec then ENOENTs
        exec: () => ({ status: null, error: Object.assign(new Error("spawn prettier ENOENT"), { code: "ENOENT" }) }),
      });
    }).not.toThrow();
    expect(result!.ran).toBe(false);
    expect(warnings.join(" ")).toMatch(/not installed/);
  });

  it("warns rather than throwing when no formatter matches the file", () => {
    const warnings: string[] = [];
    const result = runFormatter("/x/data.bin", base, {
      warn: (m) => warnings.push(m),
      exec: () => ({ status: 0 }),
    });
    expect(result.ran).toBe(false);
    expect(warnings.join(" ")).toMatch(/No formatter/);
  });

  it("never throws even if the formatter exits non-zero", () => {
    const warnings: string[] = [];
    const result = runFormatter(
      "/x/a.ts",
      base,
      { warn: (m) => warnings.push(m), fileExists: hasConfig([".prettierrc"]), exec: () => ({ status: 2 }) }
    );
    expect(result.ran).toBe(false);
    expect(warnings.join(" ")).toMatch(/exited 2/);
  });
});
