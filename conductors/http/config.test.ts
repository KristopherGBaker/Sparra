import { describe, expect, it } from "vitest";

import { defaultTailscaleIp, loadBridgeConfig, resolveBind } from "./config.ts";

const HOME = "/home/tester";

function withYaml(text: string, env: NodeJS.ProcessEnv = {}) {
  return loadBridgeConfig({
    env,
    home: HOME,
    readFile: () => text,
  });
}

describe("loadBridgeConfig", () => {
  it("loads + defaults a valid config", () => {
    const cfg = withYaml(`roots:\n  - /home/tester/proj\n`);
    expect(cfg.roots).toEqual(["/home/tester/proj"]);
    expect(cfg.port).toBe(8787);
    expect(cfg.lastNJobs).toBe(50);
    expect(cfg.auditLogPath).toBe("/home/tester/.sparra/bridge-audit.log");
    expect(cfg.eventsLogPath).toBe("/home/tester/.sparra/bridge-events.jsonl");
    expect(cfg.allowRemotePlan).toBe(false);
    expect(cfg.bind).toBeUndefined();
    expect(cfg.discoverProjects).toBe(false);
    expect(cfg.discoverDepth).toBe(3);
  });

  it("parses discoverProjects/discoverDepth from YAML", () => {
    const cfg = withYaml(`roots:\n  - /home/tester/proj\ndiscoverProjects: true\ndiscoverDepth: 5\n`);
    expect(cfg.discoverProjects).toBe(true);
    expect(cfg.discoverDepth).toBe(5);
  });

  it("THROWS when discoverDepth is negative", () => {
    expect(() => withYaml(`roots:\n  - /home/tester/proj\ndiscoverDepth: -1\n`)).toThrow(
      /discoverDepth/,
    );
  });

  it("THROWS when discoverDepth is not an integer", () => {
    expect(() => withYaml(`roots:\n  - /home/tester/proj\ndiscoverDepth: 1.5\n`)).toThrow(
      /discoverDepth/,
    );
  });

  it("THROWS when discoverDepth is absurdly large (never accepted as unbounded)", () => {
    expect(() => withYaml(`roots:\n  - /home/tester/proj\ndiscoverDepth: 1e9\n`)).toThrow(
      /discoverDepth/,
    );
  });

  it("THROWS when discoverDepth exceeds the safe max of 8", () => {
    expect(() => withYaml(`roots:\n  - /home/tester/proj\ndiscoverDepth: 9\n`)).toThrow(
      /discoverDepth/,
    );
  });

  it("accepts discoverDepth at the boundary (0 and 8)", () => {
    expect(withYaml(`roots:\n  - /home/tester/proj\ndiscoverDepth: 0\n`).discoverDepth).toBe(0);
    expect(withYaml(`roots:\n  - /home/tester/proj\ndiscoverDepth: 8\n`).discoverDepth).toBe(8);
  });

  it("honors overrides and expands ~ in roots and auditLogPath", () => {
    const cfg = withYaml(
      `roots:\n  - ~/proj\nport: 9000\nbind: 100.64.0.1\nlastNJobs: 5\nauditLogPath: ~/logs/a.log\nallowRemotePlan: true\n`,
    );
    expect(cfg.roots).toEqual(["/home/tester/proj"]);
    expect(cfg.port).toBe(9000);
    expect(cfg.bind).toBe("100.64.0.1");
    expect(cfg.lastNJobs).toBe(5);
    expect(cfg.auditLogPath).toBe("/home/tester/logs/a.log");
    expect(cfg.allowRemotePlan).toBe(true);
  });

  it("honors an explicit eventsLogPath override and expands ~ (mirrors auditLogPath)", () => {
    const cfg = withYaml(
      `roots:\n  - /home/tester/proj\neventsLogPath: ~/logs/events.jsonl\n`,
    );
    expect(cfg.eventsLogPath).toBe("/home/tester/logs/events.jsonl");
  });

  it("uses SPARRA_BRIDGE_CONFIG path (expanding ~) when set", () => {
    let seenPath = "";
    const cfg = loadBridgeConfig({
      env: { SPARRA_BRIDGE_CONFIG: "~/custom/bridge.yaml" },
      home: HOME,
      readFile: (p) => {
        seenPath = p;
        return "roots:\n  - /a\n";
      },
    });
    expect(seenPath).toBe("/home/tester/custom/bridge.yaml");
    expect(cfg.roots).toEqual(["/a"]);
  });

  it("THROWS when the config file is missing", () => {
    expect(() =>
      loadBridgeConfig({
        env: {},
        home: HOME,
        readFile: () => {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        },
      }),
    ).toThrow(/not found or unreadable/);
  });

  it("THROWS when roots is missing", () => {
    expect(() => withYaml(`port: 9000\n`)).toThrow(/roots/);
  });

  it("THROWS when roots is empty", () => {
    expect(() => withYaml(`roots: []\n`)).toThrow(/at least one absolute project root/);
  });

  it("THROWS when a root is not absolute", () => {
    expect(() => withYaml(`roots:\n  - relative/path\n`)).toThrow(/not an absolute path/);
  });

  it("THROWS on malformed YAML", () => {
    expect(() => withYaml(`roots: [\n`)).toThrow(/Could not parse|Invalid bridge config/);
  });
});

describe("resolveBind", () => {
  const noTailscale = () => undefined;

  it("prefers SPARRA_BRIDGE_BIND", () => {
    expect(
      resolveBind({ bind: "100.64.0.9" }, { env: { SPARRA_BRIDGE_BIND: "100.64.0.1" }, tailscaleIp: noTailscale }),
    ).toBe("100.64.0.1");
  });

  it("falls back to config.bind, then tailscale, then loopback", () => {
    expect(resolveBind({ bind: "100.64.0.9" }, { env: {}, tailscaleIp: noTailscale })).toBe("100.64.0.9");
    expect(resolveBind({}, { env: {}, tailscaleIp: () => "100.100.100.100" })).toBe("100.100.100.100");
    expect(resolveBind({}, { env: {}, tailscaleIp: noTailscale })).toBe("127.0.0.1");
  });

  it("trims a multi-line tailscale output to the first line", () => {
    expect(resolveBind({}, { env: {}, tailscaleIp: () => "  100.100.100.100  " })).toBe("100.100.100.100");
  });

  it("THROWS on a wildcard from env", () => {
    expect(() => resolveBind({}, { env: { SPARRA_BRIDGE_BIND: "0.0.0.0" }, tailscaleIp: noTailscale })).toThrow(
      /wildcard/,
    );
  });

  it("THROWS on a wildcard from config.bind", () => {
    expect(() => resolveBind({ bind: "0.0.0.0" }, { env: {}, tailscaleIp: noTailscale })).toThrow(/wildcard/);
    expect(() => resolveBind({ bind: "::" }, { env: {}, tailscaleIp: noTailscale })).toThrow(/wildcard/);
  });

  it("THROWS on a wildcard from tailscale rather than silently using loopback", () => {
    expect(() => resolveBind({}, { env: {}, tailscaleIp: () => "::" })).toThrow(/wildcard/);
  });
});

describe("defaultTailscaleIp", () => {
  it("returns the first CLI's IPv4 (first line, trimmed)", () => {
    expect(defaultTailscaleIp(() => "  100.100.100.100  \nfe80::1\n")).toBe("100.100.100.100");
  });

  it("IGNORES a non-IPv4 line — e.g. the GUI CLI's error text under launchd — returning undefined", () => {
    expect(defaultTailscaleIp(() => "The Tailscale GUI failed to start: (Tailscale.CLIError error 3.)")).toBe(
      undefined,
    );
  });

  it("skips a CLI that throws and uses the next candidate that answers with an IPv4", () => {
    const answers = new Map<string, string>([["/opt/homebrew/bin/tailscale", "100.64.7.7"]]);
    expect(
      defaultTailscaleIp((cli) => {
        const a = answers.get(cli);
        if (a === undefined) throw new Error("not found");
        return a;
      }),
    ).toBe("100.64.7.7");
  });

  it("returns undefined when no candidate answers", () => {
    expect(
      defaultTailscaleIp(() => {
        throw new Error("command not found");
      }),
    ).toBe(undefined);
  });
});
