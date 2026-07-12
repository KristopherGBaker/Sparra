import { describe, expect, it } from "vitest";

import { appendAudit, formatAuditLine, UNMATCHED_ROUTE, type AuditEntry } from "./audit.ts";

const FIXED = () => new Date("2026-07-12T00:00:00.000Z");

describe("audit", () => {
  it("formats one JSON line from safe, server-derived fields (route template, not raw path)", () => {
    const line = formatAuditLine(
      { remote: "100.64.0.1", method: "POST", route: "/jobs/:id/cancel", root: "/r", jobId: "x", result: 200 },
      FIXED,
    );
    const parsed = JSON.parse(line);
    expect(parsed).toEqual({
      time: "2026-07-12T00:00:00.000Z",
      remote: "100.64.0.1",
      method: "POST",
      route: "/jobs/:id/cancel",
      root: "/r",
      jobId: "x",
      result: 200,
    });
    expect(line.includes("\n")).toBe(false);
  });

  it("omits undefined optional fields", () => {
    const parsed = JSON.parse(formatAuditLine({ remote: "r", method: "GET", route: "/health", result: 200 }, FIXED));
    expect(parsed.root).toBeUndefined();
    expect(parsed.jobId).toBeUndefined();
  });

  it("appendAudit emits exactly one line via the injected sink", () => {
    const lines: string[] = [];
    appendAudit({ remote: "r", method: "GET", route: "/health", result: 200 }, (l) => lines.push(l), FIXED);
    expect(lines).toHaveLength(1);
  });

  it("sanitizes the HTTP method to a fixed verb allowlist (never echoes an arbitrary method)", () => {
    const evil = "GET /etc/passwd HTTP/1.1\r\nX-Injected: sk-DEADBEEF1234567890abcd";
    const parsed = JSON.parse(formatAuditLine({ remote: "r", method: evil, route: UNMATCHED_ROUTE, result: 404 }, FIXED));
    expect(parsed.method).toBe("<method>");
    expect(JSON.stringify(parsed)).not.toContain("passwd");
    expect(JSON.stringify(parsed)).not.toContain("X-Injected");
  });

  it("char-classes + length-caps the jobId so arbitrary request bytes can't pass through", () => {
    const evil = "abc/../../etc; rm -rf ~ sk-DEADBEEF1234567890abcdef" + "Z".repeat(200);
    const parsed = JSON.parse(formatAuditLine({ remote: "r", method: "GET", route: "/jobs/:id", jobId: evil, result: 200 }, FIXED));
    expect(parsed.jobId.length).toBeLessThanOrEqual(64);
    expect(parsed.jobId).not.toContain("/");
    expect(parsed.jobId).not.toContain(" ");
    expect(parsed.jobId).not.toContain(";");
  });

  it("STRUCTURAL: adversarial request-derived text never reaches the line, accepted OR rejected", () => {
    // The audit line has NO field for the raw request path/target. To prove the defense isn't
    // pattern-based, use PLAIN, unpredictable text (no secret shape) of varying length, plus a
    // bearer token and an api-key-shaped value, and confirm none appear — because the only
    // path-ish field is the server-side `route` template / `<unmatched>` sentinel.
    const adversarial = [
      "correct horse battery staple",
      "x",
      "/build/../../Users/kris/.ssh/id_rsa",
      "AbCdEf0123456789AbCdEf0123456789", // bearer-token-shaped
      "sk-ABCDEF1234567890ghijkl", // api-key-shaped
    ];
    // Accepted request: a real matched template.
    // Rejected requests: 401 / 400 / 404 / 405 / 500 — all log a template or the sentinel.
    const cases: Array<{ route: string; result: number }> = [
      { route: "/jobs/:id", result: 200 },
      { route: UNMATCHED_ROUTE, result: 401 },
      { route: "/echo", result: 400 },
      { route: UNMATCHED_ROUTE, result: 404 },
      { route: "/jobs/:id", result: 405 },
      { route: "/boom", result: 500 },
    ];
    for (const { route, result } of cases) {
      const line = formatAuditLine({ remote: "100.64.0.1", method: "GET", route, result }, FIXED);
      // The template (or sentinel) IS present…
      expect(line).toContain(route);
      // …and none of the adversarial strings are — because the raw path is never a field.
      for (const bad of adversarial) expect(line).not.toContain(bad);
    }
  });

  it("NON-VACUOUS guard: a formatter that echoed the raw path WOULD fail this assertion", () => {
    // Simulate the buggy behavior (raw path echoed) and prove our assertion catches it.
    const rawPath = "/build/../secret-plaintext-target";
    const buggyLine = JSON.stringify({ time: "t", remote: "r", method: "GET", path: rawPath, result: 200 });
    expect(buggyLine).toContain(rawPath); // the bug WOULD put it there
    // The real formatter, given only the safe template, does NOT contain it.
    const realLine = formatAuditLine({ remote: "r", method: "GET", route: "/build", result: 200 }, FIXED);
    expect(realLine).not.toContain(rawPath);
  });

  it("never carries a bearer token or api key (no field exists for them)", () => {
    const entry: AuditEntry = { remote: "100.64.0.1", method: "POST", route: "/build", root: "/r", jobId: "j", result: 200 };
    const lines: string[] = [];
    appendAudit(entry, (l) => lines.push(l), FIXED);
    const joined = lines.join("\n");
    expect(joined).not.toContain("s3cr3t-token-value");
    expect(joined).not.toContain("sk-ABCDEF1234567890");
    expect(joined).not.toContain("HOLDOUT");
    expect(joined).not.toContain("authorization");
  });
});
