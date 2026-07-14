/**
 * `conductors/http/dashboard.test.ts` — U4: the Sparra Bridge Console.
 *
 * DI, no socket, no DOM: imports `dashboard.client.js` directly and drives its API/controller layer
 * with a fake `fetch` + fake `storage`/`view`; drives `handlers/dashboard.ts`'s `GET /` handler with
 * an injected asset reader. Also scans the served body structurally (self-contained, responsive,
 * theme/no-Anthropic-colors).
 */
import { describe, expect, it, vi } from "vitest";

import {
  API_ENDPOINTS,
  CONSOLE_MODES,
  DEFAULT_CONSOLE_MODE,
  apiCall,
  buildRequest,
  cancelJob,
  cardScopedValue,
  createConsoleState,
  getPromptDraft,
  handleAuthError,
  handleLock,
  initConsoleMode,
  isBlankPrompt,
  launchConduct,
  normalizeMode,
  pollJob,
  projectSummary,
  refreshHealth,
  refreshProjects,
  selectTarget,
  setConsoleMode,
  setPromptDraft,
  showRoleResult,
  showUnitResult,
  submitDecision,
  triggerConduct,
  triggerPhase,
  triggerRole,
  triggerUnit,
} from "./dashboard.client.js";
import { CLIENT_SCRIPT_MARKER, createDashboardRoutes } from "./handlers/dashboard.ts";
import type { RouteContext } from "./server.ts";

const TOKEN = "test-bearer-token";

function fakeStorage(initial?: string) {
  let token: string | undefined = initial;
  return {
    getToken: vi.fn(() => token),
    setToken: vi.fn((t: string) => {
      token = t;
    }),
    clearToken: vi.fn(() => {
      token = undefined;
    }),
  };
}

function fakeView() {
  return {
    renderHealth: vi.fn(),
    renderProjects: vi.fn(),
    recordJob: vi.fn(),
    renderJob: vi.fn(),
    renderRoleSummary: vi.fn(),
    renderUnitSummary: vi.fn(),
    setAuthorized: vi.fn(),
    showReauth: vi.fn(),
    showLockToast: vi.fn(),
    showError: vi.fn(),
    // console-posture surfaces (deck/mode/selection)
    renderMode: vi.fn(),
    renderTargets: vi.fn(),
    renderDeck: vi.fn(),
    focusPrompt: vi.fn(),
    showPromptRequired: vi.fn(),
  };
}

/** A fake mode store backing the injected persistence seam (`getMode`/`setMode`) — the boot layer backs
 *  this with `localStorage`; a test can seed it and assert writes without a browser. */
function fakeModeStore(initial?: string) {
  let mode: string | undefined = initial;
  return {
    getMode: vi.fn(() => mode),
    setMode: vi.fn((m: string) => {
      mode = m;
    }),
    getToken: vi.fn(() => undefined),
    setToken: vi.fn(),
    clearToken: vi.fn(),
  };
}

function jsonResponse(status: number, data: unknown) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => data,
  };
}

function getHandler(routes: ReturnType<typeof createDashboardRoutes>, method: string, path: string) {
  const route = routes.find((r) => r.method === method && r.path === path);
  if (!route) throw new Error(`no route ${method} ${path}`);
  return route.handler;
}

function fakeCtx(config: { dashboard: boolean }): RouteContext {
  return {
    req: {} as RouteContext["req"],
    res: {} as RouteContext["res"],
    params: {},
    body: undefined,
    remote: "100.64.0.1",
    config: config as RouteContext["config"],
    jobs: {} as RouteContext["jobs"],
  };
}

// --- API layer -------------------------------------------------------------------------------

describe("API_ENDPOINTS / buildRequest / apiCall — the allowlist choke-point", () => {
  it("lists exactly the documented endpoints", () => {
    const set = API_ENDPOINTS.map((e: { method: string; path: string }) => `${e.method} ${e.path}`).sort();
    expect(set).toEqual(
      [
        "GET /health",
        "GET /projects",
        "POST /build",
        "POST /reflect",
        "POST /resume",
        "POST /init",
        "POST /freeze",
        "POST /conduct",
        "GET /jobs/:id",
        "POST /jobs/:id/cancel",
        "POST /jobs/:id/decision",
        "POST /role",
        "POST /unit",
      ].sort(),
    );
  });

  it("builds a plain GET with Bearer for an allowlisted endpoint", () => {
    const { url, init } = buildRequest("GET", "/health", { token: TOKEN });
    expect(url).toBe("/health");
    expect(init.method).toBe("GET");
    expect(init.headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
    expect(init.body).toBeUndefined();
  });

  it("adds Content-Type + JSON-encodes the body when one is given", () => {
    const { init } = buildRequest("POST", "/build", { token: TOKEN, body: { root: "/a" } });
    expect(init.headers).toEqual({ Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" });
    expect(init.body).toBe(JSON.stringify({ root: "/a" }));
  });

  it("NEVER sends a literal 'Bearer undefined' when no token is supplied", () => {
    const { init } = buildRequest("GET", "/health", {});
    expect(init.headers.Authorization).toBeUndefined();
    expect(JSON.stringify(init.headers)).not.toContain("undefined");
  });

  it("validates a real :id segment (UUID-shaped)", () => {
    const { url } = buildRequest("GET", "/jobs/abc-123_XYZ", { token: TOKEN });
    expect(url).toBe("/jobs/abc-123_XYZ");
  });

  it("THROWS for an endpoint not in the allowlist", () => {
    expect(() => buildRequest("GET", "/plan", { token: TOKEN })).toThrow();
    expect(() => buildRequest("DELETE", "/health", { token: TOKEN })).toThrow();
    expect(() => buildRequest("GET", "/", { token: TOKEN })).toThrow();
  });

  it("THROWS for an absolute or protocol-relative URL", () => {
    expect(() => buildRequest("GET", "http://evil.example/health", { token: TOKEN })).toThrow();
    expect(() => buildRequest("GET", "https://evil.example/jobs/1", { token: TOKEN })).toThrow();
    expect(() => buildRequest("GET", "//evil.example/health", { token: TOKEN })).toThrow();
  });

  it("THROWS for a path-injecting or malformed :id (../, spaces, ?/#, suffix escape)", () => {
    expect(() => buildRequest("GET", "/jobs/../../etc/passwd", { token: TOKEN })).toThrow();
    expect(() => buildRequest("GET", "/jobs/..", { token: TOKEN })).toThrow();
    expect(() => buildRequest("GET", "/jobs/abc def", { token: TOKEN })).toThrow();
    expect(() => buildRequest("GET", "/jobs/abc?x=1", { token: TOKEN })).toThrow();
    expect(() => buildRequest("GET", "/jobs/abc#frag", { token: TOKEN })).toThrow();
    expect(() => buildRequest("POST", "/jobs/abc/cancel/../../role", { token: TOKEN })).toThrow();
    // A harmless-looking prefix followed by a smuggled extra segment must still fail (length mismatch).
    expect(() => buildRequest("GET", "/jobs/abc/extra", { token: TOKEN })).toThrow();
  });

  it("apiCall maps 401 -> authError and 409 -> locked, without throwing", async () => {
    const fetch401 = vi.fn(async () => jsonResponse(401, { error: "unauthorized" }));
    const r1 = await apiCall("GET", "/health", { token: TOKEN, fetchImpl: fetch401 });
    expect(r1).toMatchObject({ ok: false, status: 401, authError: true });

    const fetch409 = vi.fn(async () => jsonResponse(409, { error: "busy", jobId: "job-1" }));
    const r2 = await apiCall("POST", "/build", { token: TOKEN, body: { root: "/a" }, fetchImpl: fetch409 });
    expect(r2).toMatchObject({ ok: false, status: 409, locked: true, data: { jobId: "job-1" } });
  });

  it("apiCall passes success through with ok:true", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { ok: true }));
    const r = await apiCall("GET", "/health", { token: TOKEN, fetchImpl });
    expect(r).toEqual({ ok: true, status: 200, data: { ok: true } });
  });
});

// --- request schemas, pinned exactly per endpoint ---------------------------------------------

describe("triggerPhase — request schema pinned per phase, Bearer on every call", () => {
  const phases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ["build", { root: "/a", fresh: true, budget: 5, maxTurns: 80 }, { root: "/a", fresh: true, budget: 5, maxTurns: 80 }],
    ["reflect", { root: "/a", apply: true }, { root: "/a", apply: true }],
    ["resume", { root: "/a" }, { root: "/a" }],
    ["init", { root: "/a", mode: "existing" }, { root: "/a", mode: "existing" }],
    ["freeze", { root: "/a" }, { root: "/a" }],
  ];

  for (const [phase, params, expectedBody] of phases) {
    it(`POST /${phase} — exact body + Bearer + records job`, async () => {
      const calls: Array<{ url: string; init: RequestInit }> = [];
      const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return jsonResponse(202, { jobId: "job-xyz" });
      });
      const storage = fakeStorage(TOKEN);
      const view = fakeView();
      await triggerPhase({ fetchImpl, storage, view }, phase, params);

      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe(`/${phase}`);
      expect(calls[0]!.init.method).toBe("POST");
      expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
      expect(JSON.parse(calls[0]!.init.body as string)).toEqual(expectedBody);
      expect(storage.getToken).toHaveBeenCalled();
      expect(view.recordJob).toHaveBeenCalledWith({ phase, root: "/a", jobId: "job-xyz" });
    });
  }

  it("GET /projects and GET /health — no body, Bearer present", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      if (url === "/health") return jsonResponse(200, { ok: true });
      return jsonResponse(200, { projects: [{ root: "/a", phase: "build", next: "sparra build (resume)" }] });
    });
    const storage = fakeStorage(TOKEN);
    const view = fakeView();
    await refreshHealth({ fetchImpl, storage, view });
    await refreshProjects({ fetchImpl, storage, view });

    expect(seen).toHaveLength(2);
    for (const call of seen) {
      expect(call.init.method).toBe("GET");
      expect(call.init.body).toBeUndefined();
      expect((call.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    }
    expect(view.renderHealth).toHaveBeenCalledWith({ ok: true });
    expect(view.renderProjects).toHaveBeenCalledWith([{ root: "/a", phase: "build", next: "sparra build (resume)" }]);
  });

  it("GET /jobs/:id and POST /jobs/:id/cancel — no body, Bearer present, correct path", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return jsonResponse(200, { id: "job-1", kind: "build", status: "running", log: "", createdAt: 1 });
    });
    const storage = fakeStorage(TOKEN);
    const view = fakeView();
    await pollJob({ fetchImpl, storage, view }, "job-1");
    await cancelJob({ fetchImpl, storage, view }, "job-1");

    expect(seen[0]).toMatchObject({ url: "/jobs/job-1" });
    expect(seen[0]!.init.method).toBe("GET");
    expect(seen[1]).toMatchObject({ url: "/jobs/job-1/cancel" });
    expect(seen[1]!.init.method).toBe("POST");
    for (const call of seen) {
      expect((call.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    }
    expect(view.renderJob).toHaveBeenCalledTimes(2);
  });

  it("POST /role and POST /unit — exact bodies, Bearer present", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      if (url === "/role") return jsonResponse(200, { roleKind: "evaluator", ok: true, verdict: "PASS" });
      return jsonResponse(200, { outcome: "accepted", contract: { agreed: true, rounds: 1 } });
    });
    const storage = fakeStorage(TOKEN);
    const view = fakeView();
    await triggerRole({ fetchImpl, storage, view }, { root: "/a", kind: "evaluator", backend: "claude" });
    await triggerUnit({ fetchImpl, storage, view }, { root: "/a", generatorModel: "sonnet", budget: 5 });

    expect(seen[0]).toMatchObject({ url: "/role" });
    expect(JSON.parse(seen[0]!.init.body as string)).toEqual({ root: "/a", kind: "evaluator", backend: "claude" });
    expect(seen[1]).toMatchObject({ url: "/unit" });
    expect(JSON.parse(seen[1]!.init.body as string)).toEqual({ root: "/a", generatorModel: "sonnet", budget: 5 });
    expect(view.renderRoleSummary).toHaveBeenCalled();
    expect(view.renderUnitSummary).toHaveBeenCalled();
  });

  it("a missing token never sends 'Bearer undefined' (surfaces auth state instead of crashing)", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: unknown) => jsonResponse(401, { error: "unauthorized" }));
    const storage = fakeStorage(undefined);
    const view = fakeView();
    await refreshHealth({ fetchImpl, storage, view });
    const init = fetchImpl.mock.calls[0]![1] as { headers?: Record<string, string> };
    expect(JSON.stringify(init.headers ?? {})).not.toContain("undefined");
    expect(view.showReauth).toHaveBeenCalled();
    expect(storage.clearToken).toHaveBeenCalled();
  });
});

// --- conduct trigger + decision card flow (U3) ---------------------------------------------------

describe("triggerConduct — body built only from schema fields; records job", () => {
  it("POST /conduct — exact body (only present fields), Bearer, records a conduct job", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return jsonResponse(202, { jobId: "cjob-1" });
    });
    const storage = fakeStorage(TOKEN);
    const view = fakeView();
    // Include an UNKNOWN extra field — it must NOT be forwarded (body built from schema fields only).
    await triggerConduct({ fetchImpl, storage, view }, { root: "/a", prompt: "build X", auto: true, mode: "llm", maxUnits: 3, budget: 5, evil: "x" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("/conduct");
    expect((seen[0]!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(seen[0]!.init.body as string)).toEqual({ root: "/a", prompt: "build X", auto: true, mode: "llm", maxUnits: 3, budget: 5 });
    expect(view.recordJob).toHaveBeenCalledWith({ phase: "conduct", root: "/a", jobId: "cjob-1" });
  });

  it("minimal params → only {root, prompt}", async () => {
    const seen: Array<{ init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      seen.push({ init });
      return jsonResponse(202, { jobId: "cjob-2" });
    });
    await triggerConduct({ fetchImpl, storage: fakeStorage(TOKEN), view: fakeView() }, { root: "/a", prompt: "hi" });
    expect(JSON.parse(seen[0]!.init.body as string)).toEqual({ root: "/a", prompt: "hi" });
  });

  it("a 409 (target busy) routes to the lock toast, not recordJob", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(409, { error: "busy", jobId: "holder" }));
    const view = fakeView();
    await triggerConduct({ fetchImpl, storage: fakeStorage(TOKEN), view }, { root: "/a", prompt: "x" });
    expect(view.showLockToast).toHaveBeenCalledWith("holder");
    expect(view.recordJob).not.toHaveBeenCalled();
  });

  it("commit/merge ride the body ONLY when toggled ON (omitted when off)", async () => {
    const bodyFor = async (params: Record<string, unknown>) => {
      let sent: unknown;
      const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
        sent = JSON.parse(init.body as string);
        return jsonResponse(202, { jobId: "c" });
      });
      await triggerConduct({ fetchImpl, storage: fakeStorage(TOKEN), view: fakeView() }, params);
      return sent;
    };
    // OFF: no commit/merge keys at all.
    expect(await bodyFor({ root: "/a", prompt: "p" })).toEqual({ root: "/a", prompt: "p" });
    // ON: exactly the toggled flags.
    expect(await bodyFor({ root: "/a", prompt: "p", commit: true })).toEqual({ root: "/a", prompt: "p", commit: true });
    expect(await bodyFor({ root: "/a", prompt: "p", commit: true, merge: true })).toEqual({ root: "/a", prompt: "p", commit: true, merge: true });
    // A false toggle is omitted, not sent as `false`.
    expect(await bodyFor({ root: "/a", prompt: "p", commit: false, merge: false })).toEqual({ root: "/a", prompt: "p" });
  });

  it("a resume runId builds a {resume,…} body (no prompt; resume-compatible fields only)", async () => {
    const seen: Array<{ init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      seen.push({ init });
      return jsonResponse(202, { jobId: "cr" });
    });
    await triggerConduct({ fetchImpl, storage: fakeStorage(TOKEN), view: fakeView() }, {
      root: "/a", resume: "run-42", auto: true, commit: true,
    });
    expect(JSON.parse(seen[0]!.init.body as string)).toEqual({ root: "/a", resume: "run-42", auto: true, commit: true });
  });
});

// --- multi-target card scoping (regression: resume read the page-global first card) ------------

describe("cardScopedValue — resume/prompt read the CLICKED card, not the page-global first card", () => {
  /** Build a fake `.target` card whose fields carry per-card values, plus the clicked buttons that
   *  live inside it. Only `closest`/`querySelector` are modelled — exactly what `cardScopedValue`
   *  uses — so this is a faithful stand-in for a rendered card without a full DOM. */
  function fakeCard(fields: Record<string, string>) {
    const inputs: Record<string, { value: string }> = {};
    for (const [sel, value] of Object.entries(fields)) inputs[sel] = { value };
    const card = {
      querySelector: (sel: string) => inputs[sel] ?? null,
    };
    const button = { closest: (sel: string) => (sel === ".target" ? card : null) };
    return { card, button };
  }

  it("resolves the resume runId scoped to the owning card (each card independent)", () => {
    const first = fakeCard({ ".conduct-resume-id": "run-FIRST" });
    const second = fakeCard({ ".conduct-resume-id": "run-SECOND" });
    expect(cardScopedValue(first.button, ".conduct-resume-id")).toBe("run-FIRST");
    expect(cardScopedValue(second.button, ".conduct-resume-id")).toBe("run-SECOND");
  });

  it("trims and returns '' when the card or field is absent", () => {
    const card = fakeCard({ ".conduct-resume-id": "  run-42  " });
    expect(cardScopedValue(card.button, ".conduct-resume-id")).toBe("run-42");
    // a button not inside any .target card → '' (no throw)
    expect(cardScopedValue({ closest: () => null }, ".conduct-resume-id")).toBe("");
    // a card missing this particular field → ''
    expect(cardScopedValue(fakeCard({}).button, ".conduct-resume-id")).toBe("");
  });

  it("the SECOND target card's resume action sends ITS OWN runId in the /conduct body (behavioral)", async () => {
    // Two allowlisted targets are rendered; only the SECOND card's runId is filled/clicked.
    const first = fakeCard({ ".conduct-resume-id": "run-FIRST" });
    const second = fakeCard({ ".conduct-resume-id": "run-SECOND" });
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      return jsonResponse(202, { jobId: "cr" });
    });
    const deps = { fetchImpl, storage: fakeStorage(TOKEN), view: fakeView() };

    // Reproduce exactly what dashboard.html's `runConductResume(el)` does for the SECOND card's
    // button: resolve the runId scoped to that card, then POST /conduct with resume-only fields.
    const resume = cardScopedValue(second.button, ".conduct-resume-id");
    await triggerConduct(deps, { root: "/second", resume, auto: false });

    expect(bodies).toHaveLength(1);
    // `auto` rides along exactly as `runConductResume` sends it (resume-compatible field); the runId
    // is the SECOND card's, which is the point of this test.
    expect(bodies[0]).toEqual({ root: "/second", resume: "run-SECOND", auto: false });
    // The old page-global `document.querySelector('.conduct-resume-id')` bug would have sent the
    // FIRST card's runId — assert we did NOT.
    expect(bodies[0]!.resume).not.toBe("run-FIRST");
    // sanity: the first card genuinely holds a DIFFERENT id (fixture is non-vacuous).
    expect(cardScopedValue(first.button, ".conduct-resume-id")).toBe("run-FIRST");
  });
});

// --- console posture: mode / selection / drafts / launch guard (U4 two-mode redesign) ------------

describe("console mode — closed set, default conduct, invalid-value fallback (A1)", () => {
  it("exposes exactly the two valid postures with conduct as default", () => {
    expect([...CONSOLE_MODES]).toEqual(["conduct", "full cycle"]);
    expect(DEFAULT_CONSOLE_MODE).toBe("conduct");
  });

  it("normalizeMode accepts ONLY the two encodings, else falls back to conduct", () => {
    expect(normalizeMode("conduct")).toBe("conduct");
    expect(normalizeMode("full cycle")).toBe("full cycle");
    for (const bad of ["banana", "", "Conduct", "full-cycle", "fullcycle", undefined, null, 3, {}]) {
      expect(normalizeMode(bad as unknown as string)).toBe("conduct");
    }
  });

  it("init with EMPTY storage → conduct; with an INVALID seed (\"banana\") → conduct", () => {
    const view1 = fakeView();
    const state1 = createConsoleState();
    const mode1 = initConsoleMode({ storage: fakeModeStore(undefined), view: view1, state: state1 });
    expect(mode1).toBe("conduct");
    expect(state1.mode).toBe("conduct");
    expect(view1.renderMode).toHaveBeenCalledWith("conduct");

    const view2 = fakeView();
    const state2 = createConsoleState();
    const mode2 = initConsoleMode({ storage: fakeModeStore("banana"), view: view2, state: state2 });
    expect(mode2).toBe("conduct");
    expect(view2.renderMode).toHaveBeenCalledWith("conduct");
  });
});

describe("console mode — persistence + toggle drives rendering (A2)", () => {
  it("init RESTORES a persisted full-cycle value", () => {
    const view = fakeView();
    const state = createConsoleState();
    const mode = initConsoleMode({ storage: fakeModeStore("full cycle"), view, state });
    expect(mode).toBe("full cycle");
    expect(state.mode).toBe("full cycle");
    expect(view.renderMode).toHaveBeenCalledWith("full cycle");
  });

  it("toggling WRITES the new value to storage AND drives a re-render with the new mode", () => {
    const storage = fakeModeStore("conduct");
    const view = fakeView();
    const state = createConsoleState();
    const mode = setConsoleMode({ storage, view, state }, "full cycle");
    expect(mode).toBe("full cycle");
    expect(state.mode).toBe("full cycle");
    expect(storage.setMode).toHaveBeenCalledWith("full cycle"); // persisted
    expect(view.renderMode).toHaveBeenCalledWith("full cycle"); // rendered
  });

  it("an invalid toggle value is coerced to conduct before persisting/rendering", () => {
    const storage = fakeModeStore("full cycle");
    const view = fakeView();
    const state = createConsoleState();
    const mode = setConsoleMode({ storage, view, state }, "banana");
    expect(mode).toBe("conduct");
    expect(storage.setMode).toHaveBeenCalledWith("conduct");
    expect(view.renderMode).toHaveBeenCalledWith("conduct");
  });
});

describe("selectTarget — the ONE selection choke point drives BOTH surfaces (A7)", () => {
  it("updates the selected root and re-renders the rail cards AND the deck", () => {
    const view = fakeView();
    const state = createConsoleState();
    selectTarget({ view, state }, "/tmp/proj-b");
    expect(state.selectedRoot).toBe("/tmp/proj-b");
    expect(view.renderTargets).toHaveBeenCalled(); // rail card selection
    expect(view.renderDeck).toHaveBeenCalled(); // deck target selector
  });
});

describe("per-target prompt drafts survive target switches (A6)", () => {
  it("A→type→B→type→back-to-A restores A's exact text (not one shared buffer)", () => {
    const state = createConsoleState();
    // select A, type A's draft
    selectTarget({ view: fakeView(), state }, "/tmp/proj-a");
    setPromptDraft(state, "/tmp/proj-a", "add dark mode");
    // select B, type a DIFFERENT draft
    selectTarget({ view: fakeView(), state }, "/tmp/proj-b");
    setPromptDraft(state, "/tmp/proj-b", "fix the login bug");
    // switch back to A — A's text is intact, B's too
    selectTarget({ view: fakeView(), state }, "/tmp/proj-a");
    expect(getPromptDraft(state, "/tmp/proj-a")).toBe("add dark mode");
    expect(getPromptDraft(state, "/tmp/proj-b")).toBe("fix the login bug");
    // a never-typed target has an empty draft
    expect(getPromptDraft(state, "/tmp/proj-c")).toBe("");
  });
});

describe("empty-prompt launch guard — non-degenerate triple (A5)", () => {
  it("whitespace-only prompt disables launch (ZERO fetch); the SAME state with text fires EXACTLY ONE POST /conduct", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url);
      return jsonResponse(202, { jobId: "cjob-1" });
    });
    const view = fakeView();
    const deps = { fetchImpl, storage: fakeStorage(TOKEN), view };

    // whitespace-only prompt: predicate blank, no fetch, a visible reason surfaces
    expect(isBlankPrompt("  \n  ")).toBe(true);
    const blank = await launchConduct(deps, { root: "/tmp/proj-a", prompt: "  \n  " });
    expect(blank).toEqual({ launched: false });
    expect(calls).toHaveLength(0);
    expect(view.showPromptRequired).toHaveBeenCalled();

    // same deck state, now a non-empty prompt: enabled, exactly one POST /conduct
    expect(isBlankPrompt("add dark mode")).toBe(false);
    const ok = await launchConduct(deps, { root: "/tmp/proj-a", prompt: "add dark mode" });
    expect(ok).toEqual({ launched: true });
    expect(calls).toEqual(["/conduct"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("POST /conduct body — full-control + minimal deep-equal fixtures (A3, A4)", () => {
  async function bodyFor(params: Record<string, unknown>) {
    let sent: unknown;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      sent = JSON.parse(init.body as string);
      return jsonResponse(202, { jobId: "c" });
    });
    await triggerConduct({ fetchImpl, storage: fakeStorage(TOKEN), view: fakeView() }, params);
    return sent;
  }

  it("full-control (non-default brain) → body DEEP-EQUALS exactly the fixture, no extra keys", async () => {
    expect(
      await bodyFor({ root: "/tmp/proj-a", prompt: "add dark mode", mode: "llm", maxUnits: 3, auto: true, commit: true, merge: true, budget: 2.5, maxTurns: 40 }),
    ).toEqual({ root: "/tmp/proj-a", prompt: "add dark mode", mode: "llm", maxUnits: 3, auto: true, commit: true, merge: true, budget: 2.5, maxTurns: 40 });
  });

  it("minimal request → body deep-equals {root, prompt} only", async () => {
    expect(await bodyFor({ root: "/tmp/proj-a", prompt: "fix login" })).toEqual({ root: "/tmp/proj-a", prompt: "fix login" });
  });

  it("resume path → only {root, resume, auto?, commit?, merge?} — no prompt, no run-shaping fields (A4)", async () => {
    expect(await bodyFor({ root: "/tmp/proj-a", resume: "run-42", auto: false })).toEqual({ root: "/tmp/proj-a", resume: "run-42", auto: false });
  });
});

describe("merge ⇒ commit coupling with a defined, non-sticky reverse transition (A19)", () => {
  async function bodyFor(params: Record<string, unknown>) {
    let sent: unknown;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      sent = JSON.parse(init.body as string);
      return jsonResponse(202, { jobId: "c" });
    });
    await triggerConduct({ fetchImpl, storage: fakeStorage(TOKEN), view: fakeView() }, params);
    return sent;
  }

  it("merge ON with commit toggle OFF → body carries commit:true AND merge:true", async () => {
    expect(await bodyFor({ root: "/a", prompt: "p", commit: false, merge: true })).toEqual({ root: "/a", prompt: "p", commit: true, merge: true });
  });

  it("then merge toggled OFF (commit still off) → body carries NEITHER commit nor merge (never left forced on)", async () => {
    expect(await bodyFor({ root: "/a", prompt: "p", commit: false, merge: false })).toEqual({ root: "/a", prompt: "p" });
  });

  it("contrast: commit ON + merge OFF → commit:true, no merge key", async () => {
    expect(await bodyFor({ root: "/a", prompt: "p", commit: true, merge: false })).toEqual({ root: "/a", prompt: "p", commit: true });
  });
});

describe("boot autofocus is DURABLE across the async /projects load (A20a)", () => {
  it("conduct mode: after projects load rebuilds the deck, focus is restored to the hero prompt (AFTER the rebuild)", async () => {
    const order: string[] = [];
    const view = fakeView();
    view.renderProjects = vi.fn(() => order.push("renderProjects"));
    view.focusPrompt = vi.fn(() => order.push("focusPrompt"));
    const state = createConsoleState(); // default conduct
    const fetchImpl = vi.fn(async () => jsonResponse(200, { projects: [{ root: "/a", phase: "build", next: "x" }] }));
    await refreshProjects({ fetchImpl, storage: fakeStorage(TOKEN), view, state });
    expect(view.renderProjects).toHaveBeenCalledTimes(1);
    expect(view.focusPrompt).toHaveBeenCalledTimes(1);
    // focus lands AFTER the deck is rebuilt, so the FINAL (loaded) textarea owns focus — not the
    // transient boot-time one that renderProjects replaced.
    expect(order).toEqual(["renderProjects", "focusPrompt"]);
  });

  it("full-cycle mode: the hidden deck prompt does NOT steal focus on project load", async () => {
    const view = fakeView();
    const state = { ...createConsoleState(), mode: "full cycle" };
    const fetchImpl = vi.fn(async () => jsonResponse(200, { projects: [{ root: "/a", phase: "build", next: "x" }] }));
    await refreshProjects({ fetchImpl, storage: fakeStorage(TOKEN), view, state });
    expect(view.renderProjects).toHaveBeenCalledTimes(1);
    expect(view.focusPrompt).not.toHaveBeenCalled();
  });
});

describe("DOM-free proven behaviorally (A13a)", () => {
  it("runs in a plain Node env (no document) yet every console-posture flow works", async () => {
    // Precondition: vitest's plain Node env has no DOM — any direct document/window/localStorage/
    // sessionStorage access on an executed path would throw ReferenceError and fail this test. (Read via
    // `globalThis` so the assertion type-checks without pulling in the DOM lib.)
    expect(typeof (globalThis as Record<string, unknown>).document).toBe("undefined");

    const storage = fakeModeStore("full cycle");
    const view = fakeView();
    const state = createConsoleState();
    expect(initConsoleMode({ storage, view, state })).toBe("full cycle");
    expect(setConsoleMode({ storage, view, state }, "conduct")).toBe("conduct");
    selectTarget({ view, state }, "/tmp/proj-a");
    setPromptDraft(state, "/tmp/proj-a", "draft text");
    expect(getPromptDraft(state, "/tmp/proj-a")).toBe("draft text");

    const fetchImpl = vi.fn(async () => jsonResponse(202, { jobId: "j" }));
    await launchConduct({ fetchImpl, storage: fakeStorage(TOKEN), view }, { root: "/tmp/proj-a", prompt: "go" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("pollJob — pendingDecisions drive the view, projected (no raw field crosses)", () => {
  it("a job with pendingDecisions is projected to the allowlist fields before renderJob", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        id: "cjob-1",
        kind: "conduct",
        status: "running",
        log: "",
        createdAt: 1,
        pendingDecisions: [
          // a planted extra field must be dropped by the client projection too:
          { seq: 1, unit: "unit-001", kind: "unit-exhausted", question: "Q?", options: ["finalize", "abandon"], default: "finalize", expiresAt: "z", secret: "CLIENT-LEAK" },
        ],
      }),
    );
    const view = fakeView();
    await pollJob({ fetchImpl, storage: fakeStorage(TOKEN), view }, "cjob-1");
    expect(view.renderJob).toHaveBeenCalledTimes(1);
    const arg = view.renderJob.mock.calls[0]![0] as { status: string; pendingDecisions: Array<Record<string, unknown>> };
    expect(arg.status).toBe("running");
    expect(arg.pendingDecisions).toEqual([
      { seq: 1, unit: "unit-001", kind: "unit-exhausted", question: "Q?", options: ["finalize", "abandon"], default: "finalize", expiresAt: "z" },
    ]);
    expect(JSON.stringify(arg.pendingDecisions)).not.toContain("CLIENT-LEAK");
  });

  it("a job without pendingDecisions passes through unchanged", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { id: "j", kind: "build", status: "running", log: "", createdAt: 1 }));
    const view = fakeView();
    await pollJob({ fetchImpl, storage: fakeStorage(TOKEN), view }, "j");
    expect(view.renderJob).toHaveBeenCalledWith({ id: "j", kind: "build", status: "running", log: "", createdAt: 1 });
  });
});

describe("submitDecision — posts {seq, answer, note?} and refreshes", () => {
  it("posts to /jobs/:id/decision with the exact body, then re-polls the job on success", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      if (url === "/jobs/cjob-1/decision") return jsonResponse(200, { ok: true, seq: 1, chosen: "abandon" });
      return jsonResponse(200, { id: "cjob-1", kind: "conduct", status: "running", log: "", createdAt: 1, pendingDecisions: [] });
    });
    const view = fakeView();
    await submitDecision({ fetchImpl, storage: fakeStorage(TOKEN), view }, "cjob-1", { seq: 1, answer: "abandon", note: "why" });
    expect(seen[0]!.url).toBe("/jobs/cjob-1/decision");
    expect(seen[0]!.init.method).toBe("POST");
    expect(JSON.parse(seen[0]!.init.body as string)).toEqual({ seq: 1, answer: "abandon", note: "why" });
    // refresh happened (a second call to GET /jobs/:id), and the answered job re-rendered.
    expect(seen[1]!.url).toBe("/jobs/cjob-1");
    expect(view.renderJob).toHaveBeenCalled();
  });

  it("an empty note is omitted from the body", async () => {
    const seen: Array<{ init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      seen.push({ init });
      if (url.endsWith("/decision")) return jsonResponse(200, { ok: true });
      return jsonResponse(200, { id: "j", status: "running", pendingDecisions: [] });
    });
    await submitDecision({ fetchImpl, storage: fakeStorage(TOKEN), view: fakeView() }, "j", { seq: 2, answer: "finalize", note: "" });
    expect(JSON.parse(seen[0]!.init.body as string)).toEqual({ seq: 2, answer: "finalize" });
  });

  it("a 409 (already resolved) routes to the lock toast; a 401 clears the token", async () => {
    const fetch409 = vi.fn(async () => jsonResponse(409, { error: "already resolved", jobId: "j" }));
    const view409 = fakeView();
    await submitDecision({ fetchImpl: fetch409, storage: fakeStorage(TOKEN), view: view409 }, "j", { seq: 1, answer: "finalize" });
    expect(view409.showLockToast).toHaveBeenCalled();

    const fetch401 = vi.fn(async () => jsonResponse(401, { error: "unauthorized" }));
    const storage = fakeStorage(TOKEN);
    const view401 = fakeView();
    await submitDecision({ fetchImpl: fetch401, storage, view: view401 }, "j", { seq: 1, answer: "finalize" });
    expect(storage.clearToken).toHaveBeenCalled();
    expect(view401.showReauth).toHaveBeenCalled();
  });
});

// --- 401 / 409 orchestration --------------------------------------------------------------------

describe("handleAuthError / handleLock", () => {
  it("401 clears the stored token and signals re-auth", () => {
    const storage = fakeStorage(TOKEN);
    const view = fakeView();
    handleAuthError({ storage, view });
    expect(storage.clearToken).toHaveBeenCalled();
    expect(storage.getToken()).toBeUndefined();
    expect(view.setAuthorized).toHaveBeenCalledWith(false);
    expect(view.showReauth).toHaveBeenCalled();
  });

  it("409 signals the lock toast with the holder jobId", () => {
    const view = fakeView();
    handleLock({ view }, "holder-job-1");
    expect(view.showLockToast).toHaveBeenCalledWith("holder-job-1");
  });

  it("a 409 encountered mid-flow (triggerPhase) routes to handleLock, not a generic error", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(409, { error: "busy", jobId: "job-holder" }));
    const storage = fakeStorage(TOKEN);
    const view = fakeView();
    await triggerPhase({ fetchImpl, storage, view }, "build", { root: "/a" });
    expect(view.showLockToast).toHaveBeenCalledWith("job-holder");
    expect(view.recordJob).not.toHaveBeenCalled();
  });
});

// --- holdout-safe projection (adversarial) -------------------------------------------------------

describe("projectSummary — holdout-safe projection", () => {
  it("/role payload: keeps ONLY the allowlisted fields, drops everything else (adversarial)", () => {
    const payload = {
      roleKind: "evaluator",
      ok: true,
      verdict: "PASS",
      weightedTotal: 91.2,
      passThreshold: 85,
      blocking: [],
      backend: "claude",
      model: "opus",
      tokens: 1000,
      costUsd: 0.5,
      sameModelGrade: false,
      // adversarial extras that must NEVER survive projection:
      resultText: "the full raw transcript",
      traceDir: "/secret/trace",
      resultDigest: "raw verdict dump content",
      holdoutCanary: "CANARY-DO-NOT-LEAK-12345",
    };
    const projected = projectSummary(payload);
    expect(projected).toEqual({
      roleKind: "evaluator",
      ok: true,
      verdict: "PASS",
      weightedTotal: 91.2,
      passThreshold: 85,
      blocking: [],
      backend: "claude",
      model: "opus",
      tokens: 1000,
      costUsd: 0.5,
      sameModelGrade: false,
    });
    const dump = JSON.stringify(projected);
    expect(dump).not.toContain("CANARY-DO-NOT-LEAK-12345");
    expect(dump).not.toContain("raw transcript");
    expect(dump).not.toContain("raw verdict dump");
    expect(projected).not.toHaveProperty("resultText");
    expect(projected).not.toHaveProperty("traceDir");
  });

  it("/unit payload: flattens to ONLY outcome/contractAgreed/contractRounds/cycleOutcome/cycleRounds/finalVerdict, and re-projects finalVerdict too (adversarial)", () => {
    const payload = {
      outcome: "accepted",
      contract: { agreed: true, rounds: 2, rawCritiques: ["holdout-bearing critique text"] },
      cycle: {
        outcome: "accept",
        rounds: 3,
        finalVerdict: {
          roleKind: "evaluator",
          ok: true,
          verdict: "PASS",
          weightedTotal: 90,
          passThreshold: 85,
          blocking: [],
          backend: "claude",
          model: "opus",
          tokens: 500,
          costUsd: 0.2,
          sameModelGrade: false,
          resultText: "leaked transcript inside finalVerdict",
          holdoutCanary: "CANARY-INSIDE-FINALVERDICT",
        },
      },
      // top-level adversarial extras:
      resultText: "top-level raw transcript",
      traceDir: "/secret/trace2",
      holdoutCanary: "TOP-LEVEL-CANARY",
    };
    const projected = projectSummary(payload) as Record<string, unknown>;
    expect(Object.keys(projected).sort()).toEqual(
      ["outcome", "contractAgreed", "contractRounds", "cycleOutcome", "cycleRounds", "finalVerdict"].sort(),
    );
    expect(projected.outcome).toBe("accepted");
    expect(projected.contractAgreed).toBe(true);
    expect(projected.contractRounds).toBe(2);
    expect(projected.cycleOutcome).toBe("accept");
    expect(projected.cycleRounds).toBe(3);
    const finalVerdict = projected.finalVerdict as Record<string, unknown>;
    expect(finalVerdict).not.toHaveProperty("resultText");
    expect(finalVerdict).not.toHaveProperty("holdoutCanary");
    const dump = JSON.stringify(projected);
    expect(dump).not.toContain("CANARY");
    expect(dump).not.toContain("leaked transcript");
    expect(dump).not.toContain("raw transcript");
    expect(dump).not.toContain("rawCritiques");
  });

  it("a pass-through mutation (spread payload) would fail this test — sanity check the fixture is non-vacuous", () => {
    // Simulates the REGRESSION this test guards against: a naive `{...payload}` implementation.
    const payload = { roleKind: "generator", resultText: "SHOULD-NOT-LEAK" };
    const passthrough = { ...payload };
    expect(passthrough).toHaveProperty("resultText"); // the naive approach WOULD leak
    expect(projectSummary(payload)).not.toHaveProperty("resultText"); // ours doesn't
  });

  it("non-object / unknown-shape payloads project to {}", () => {
    expect(projectSummary(null as unknown as Record<string, unknown>)).toEqual({});
    expect(projectSummary({ somethingElse: true } as unknown as Record<string, unknown>)).toEqual({});
  });
});

describe("showRoleResult / showUnitResult — only projected fields ever reach the view", () => {
  it("showRoleResult renders the projection, not the raw payload", () => {
    const view = fakeView();
    const payload = { roleKind: "generator", ok: true, verdict: "PASS", resultText: "LEAK" };
    showRoleResult({ view }, payload);
    expect(view.renderRoleSummary).toHaveBeenCalledWith({ roleKind: "generator", ok: true, verdict: "PASS" });
  });

  it("showUnitResult renders the projection, not the raw payload", () => {
    const view = fakeView();
    const payload = { outcome: "accepted", contract: { agreed: true, rounds: 1 }, resultText: "LEAK" };
    showUnitResult({ view }, payload);
    expect(view.renderUnitSummary).toHaveBeenCalledWith({ outcome: "accepted", contractAgreed: true, contractRounds: 1 });
  });
});

// --- handlers/dashboard.ts: GET / ----------------------------------------------------------------

describe("GET / handler (createDashboardRoutes)", () => {
  const FAKE_HTML = `<!doctype html><html><head></head><body>${CLIENT_SCRIPT_MARKER}</body></html>`;
  const FAKE_CLIENT = "export const marker = 'client-js-inlined';";
  const fakeAssets = () => ({ html: FAKE_HTML, client: FAKE_CLIENT });

  it("serves 200 text/html, body starts <!doctype html>, no token required", () => {
    const readAssets = vi.fn(fakeAssets);
    const routes = createDashboardRoutes({ readAssets });
    const handler = getHandler(routes, "GET", "/");
    const result = handler(fakeCtx({ dashboard: true }));
    expect(result).not.toBeInstanceOf(Promise);
    const r = result as { status: number; html?: string };
    expect(r.status).toBe(200);
    expect(r.html).toBeDefined();
    expect(/^<!doctype html>/i.test(r.html!)).toBe(true);
    expect(r.html).toContain("client-js-inlined");
  });

  it("reads/assembles the asset EXACTLY ONCE (one spy call) across >= 3 requests", () => {
    const readAssets = vi.fn(fakeAssets);
    const routes = createDashboardRoutes({ readAssets });
    const handler = getHandler(routes, "GET", "/");
    handler(fakeCtx({ dashboard: true }));
    handler(fakeCtx({ dashboard: true }));
    handler(fakeCtx({ dashboard: true }));
    // ONE call to the reader seam total — both assets come back from that single call — never
    // re-read on later requests.
    expect(readAssets).toHaveBeenCalledTimes(1);
  });

  it("dashboard:false -> 404, and never even reads the assets", () => {
    const readAssets = vi.fn(fakeAssets);
    const routes = createDashboardRoutes({ readAssets });
    const handler = getHandler(routes, "GET", "/");
    const result = handler(fakeCtx({ dashboard: false })) as { status: number; html?: string };
    expect(result.status).toBe(404);
    expect(result.html).toBeUndefined();
    expect(readAssets).not.toHaveBeenCalled();
  });

  it("throws (refuses to serve) if the marker is missing from dashboard.html", () => {
    const readAssets = vi.fn(() => ({ html: "<!doctype html><html></html>", client: FAKE_CLIENT }));
    const routes = createDashboardRoutes({ readAssets });
    const handler = getHandler(routes, "GET", "/");
    expect(() => handler(fakeCtx({ dashboard: true }))).toThrow();
  });
});

// --- the REAL served page: self-containment + responsive/theme structure -------------------------

describe("the real served page (real dashboard.html + dashboard.client.js, real reader)", () => {
  function realRoutes() {
    return createDashboardRoutes();
  }

  function servedBody(): string {
    const routes = realRoutes();
    const handler = getHandler(routes, "GET", "/");
    const result = handler(fakeCtx({ dashboard: true })) as { status: number; html?: string };
    expect(result.status).toBe(200);
    return result.html!;
  }

  it("starts with <!doctype html> and inlines dashboard.client.js (single source of truth, no dup)", () => {
    const body = servedBody();
    expect(/^<!doctype html>/i.test(body)).toBe(true);
    expect(body).toContain("<script");
    // The client's own exported API allowlist constant proves the REAL client.js text was inlined.
    expect(body).toContain("API_ENDPOINTS");
    expect(body).not.toContain("__SPARRA_DASHBOARD_CLIENT__"); // marker was replaced, not left dangling
  });

  it("is self-contained: no external ref, no separate-file asset ref, in ANY resource construct", () => {
    const body = servedBody();
    expect(body).not.toMatch(/https?:\/\//i);
    expect(body).not.toMatch(/(?:src|href)\s*=\s*["']\/\//i); // protocol-relative
    expect(body).not.toMatch(/<link\b/i);
    expect(body).not.toMatch(/<script[^>]+\bsrc\s*=/i);
    expect(body).not.toMatch(/<iframe\b/i);
    expect(body).not.toMatch(/srcset\s*=/i);
    expect(body).not.toMatch(/url\(\s*['"]?(?:https?:)?\/\//i);
    expect(body).not.toMatch(/@import\b/i);
  });

  it("a mutated page that adds a relative external asset ref FAILS the self-containment scan (non-vacuous)", () => {
    const mutated = servedBody() + '<script src="./evil.js"></script>';
    expect(mutated).toMatch(/<script[^>]+\bsrc\s*=/i);
  });

  it("has a responsive viewport meta tag", () => {
    const body = servedBody();
    expect(body).toMatch(/<meta\s+name=["']viewport["']\s+content=["']width=device-width,\s*initial-scale=1["']/i);
  });

  it("uses responsive CSS constructs: a media query, and no fixed px width on html/body", () => {
    const body = servedBody();
    expect(body).toMatch(/@media\s*\(/);
    const bodyRuleMatch = body.match(/body\s*\{[^}]*\}/g) ?? [];
    for (const rule of bodyRuleMatch) {
      expect(rule).not.toMatch(/\bwidth\s*:\s*\d+px/);
    }
    const htmlRuleMatch = body.match(/html\s*,?\s*body\s*\{[^}]*\}/g) ?? [];
    for (const rule of htmlRuleMatch) {
      expect(rule).not.toMatch(/\bwidth\s*:\s*\d+px/);
    }
  });

  it("wide regions (log terminal, tables) use overflow-x:auto", () => {
    const body = servedBody();
    expect(body).toMatch(/\.term-body\s*\{[^}]*overflow-x\s*:\s*auto/);
  });

  it("defines light AND dark theming, the phosphor accent, and carries NO Anthropic brand hex", () => {
    const body = servedBody();
    expect(body).toMatch(/data-theme=["']light["']/);
    expect(body).toMatch(/color-scheme:\s*dark/);
    expect(body.toLowerCase()).toContain("#35d6e0");
    for (const hex of ["#d97757", "#cc785c", "#da7756", "#f0eee6", "#faf9f5"]) {
      expect(body.toLowerCase()).not.toContain(hex);
    }
  });

  it("status is conveyed by dot+label class, not color alone (status-tag/badge text present)", () => {
    const body = servedBody();
    expect(body).toMatch(/status-tag/);
    expect(body).toMatch(/j-badge/);
  });

  it("has NO inline on* event-handler attributes — every control is wired via addEventListener/delegation", () => {
    const body = servedBody();
    // Module-scoped functions are not `window` globals, so an inline `onclick="..."` resolves to
    // undefined at click time (the round-2 regression) — assert none remain anywhere in the page.
    expect(body).not.toMatch(/\son(?:click|change|dblclick|input|submit)\s*=/i);
  });

  it("exposes a live /role control (run-role data-action) wired the same way as /unit", () => {
    const body = servedBody();
    expect(body).toMatch(/data-action=["']run-role["']/);
    expect(body).toMatch(/data-action=["']run-unit["']/);
    expect(body).toContain("role-kind-select");
    // The controller's real triggerRole (not a bespoke fetch) is what the page's own run-role wiring
    // calls — proven by the exported name appearing in the inlined client source.
    expect(body).toMatch(/function triggerRole\(/);
  });

  it("exposes a conduct trigger (prompt + mode + auto + max-units) wired to the real controller", () => {
    const body = servedBody();
    expect(body).toMatch(/data-action=["']run-conduct["']/);
    expect(body).toContain("conduct-prompt");
    expect(body).toContain("conduct-mode-select");
    expect(body).toMatch(/data-action=["']toggle-conduct-auto["']/);
    expect(body).toMatch(/data-action=["']step-units["']/);
    // the page's run-conduct wiring calls the exported controller, not a bespoke fetch.
    expect(body).toMatch(/function triggerConduct\(/);
    expect(body).not.toMatch(/\son(?:click|change)\s*=/i); // still no inline handlers
  });

  it("exposes the conduct commit/merge toggles + a resume affordance in the trigger card", () => {
    const body = servedBody();
    expect(body).toMatch(/data-action=["']toggle-conduct-commit["']/);
    expect(body).toMatch(/data-action=["']toggle-conduct-merge["']/);
    // resume affordance: a runId input + a run-conduct-resume action, both wired to the real controller.
    expect(body).toMatch(/data-action=["']run-conduct-resume["']/);
    expect(body).toContain("conduct-resume-id");
    expect(body).toMatch(/function runConductResume\(/);
    expect(body).not.toMatch(/\son(?:click|change)\s*=/i); // still no inline handlers
  });

  it("per-card reads (role kind) go through the card-scoped helper, NOT a page-global querySelector", () => {
    const body = servedBody();
    // The conduct prompt/resume now live in the singular full-width deck (read by id), so there is no
    // page-global `.conduct-prompt`/`.conduct-resume-id` lookup that could read the wrong card.
    expect(body).not.toMatch(/document\.querySelector\(\s*['"]\.conduct-resume-id['"]\s*\)/);
    expect(body).not.toMatch(/document\.querySelector\(\s*['"]\.conduct-prompt['"]\s*\)/);
    // The remaining per-card control (the full-cycle role-kind select) is read scoped to the clicked
    // card via the helper (walks up to `.target` via `closest`), never a page-global first match.
    expect(body).not.toMatch(/document\.querySelector\(\s*['"]\.role-kind-select['"]\s*\)/);
    expect(body).toMatch(/function cardScopedValue\(/);
    expect(body).toMatch(/cardScopedValue\(\s*el\s*,\s*['"]\.role-kind-select['"]\s*\)/);
  });

  it("exposes the decision card + answer flow (answer-decision data-action → submitDecision) with an awaiting badge", () => {
    const body = servedBody();
    expect(body).toMatch(/data-action=["']answer-decision["']/);
    expect(body).toContain("decision-card");
    expect(body).toContain("badge-awaiting"); // distinct pending visual state
    // the answer flow uses the real controller (POST /jobs/:id/decision), not a bespoke fetch.
    expect(body).toMatch(/function submitDecision\(/);
  });

  // ---- two-mode redesign: header mode switch + conduct deck + slim cards ----

  it("carries the header mode switch (conduct | full cycle), default conduct, backed by the controller", () => {
    const body = servedBody();
    expect(body).toContain('class="mode-switch"');
    expect(body).toMatch(/data-action=["']set-mode["'][^>]*data-mode=["']conduct["']/);
    expect(body).toMatch(/data-action=["']set-mode["'][^>]*data-mode=["']full cycle["']/);
    // the app container defaults to conduct posture; the switch calls the real controller.
    expect(body).toMatch(/data-mode=["']conduct["']/);
    expect(body).toMatch(/function setConsoleMode\(/);
    expect(body).toMatch(/function initConsoleMode\(/);
    expect(body).not.toMatch(/\son(?:click|change)\s*=/i); // still no inline handlers
  });

  it("the deck exists, is hidden ONLY in full-cycle mode, and carries the pipeline strip tokens (A10)", () => {
    const body = servedBody();
    expect(body).toContain('id="deck"');
    // deck hidden only in the expert full-cycle posture (data-mode attribute selector).
    expect(body).toMatch(/\[data-mode=["']full cycle["']\]\s*\.deck\s*\{[^}]*display:\s*none/);
    // the pipeline strip renders the real sequence tokens, in order.
    for (const token of ["decompose", "contract", "generate", "evaluate", "decide"]) {
      expect(body).toContain(token);
    }
    expect(body).toContain("pipeline");
  });

  it("the deck is the conduct front door: hero prompt, brain select, target chips, launch + resume", () => {
    const body = servedBody();
    expect(body).toContain("deck-prompt");
    expect(body).toContain("conduct-prompt");
    expect(body).toContain("deck-chip"); // target selector chips synced with the rail
    expect(body).toContain("conduct-mode-select");
    expect(body).toMatch(/data-action=["']run-conduct["']/);
    expect(body).toMatch(/data-action=["']run-conduct-resume["']/);
    expect(body).toContain("conduct-resume-id");
    // launch is disabled-with-reason when the prompt is blank (guard wired to the controller).
    expect(body).toMatch(/function launchConduct\(/);
    expect(body).toContain("deck-reason");
    // the deck routes selection through the ONE choke point (chip → chooseTarget → selectTarget).
    expect(body).toMatch(/function selectTarget\(/);
  });

  it("conduct-mode cards are slim selectors (no action buttons); full-cycle reveals the phase surface (A9)", () => {
    const body = servedBody();
    // the phase-action block is emitted by a dedicated helper, only when full cycle is active.
    expect(body).toMatch(/function targetActions\(/);
    expect(body).toMatch(/fullCycle\s*\?\s*targetActions\(t\)\s*:\s*''/);
    // full-cycle actions still exist in the source (build/reflect/…/role/unit + fresh toggle).
    expect(body).toMatch(/data-action=["']trigger["'][^>]*data-phase=["']build["']/);
    expect(body).toMatch(/data-action=["']run-role["']/);
    expect(body).toMatch(/data-action=["']run-unit["']/);
    expect(body).toMatch(/data-action=["']toggle-fresh["']/);
    // conduct-mode cards slim down via the data-mode selector (no visible actions).
    expect(body).toMatch(/\[data-mode=["']conduct["']\]\s*\.target\s*\.actions\s*\{[^}]*display:\s*none/);
  });

  it("jobs feed + detail stage render OUTSIDE the mode-conditional branches (present in BOTH modes, A11)", () => {
    const body = servedBody();
    // the grid (targets rail + jobs feed + stage) is not gated by data-mode — only the deck and the
    // card variant are. The feed/stage containers are always in the markup.
    expect(body).toContain('id="jobList"');
    expect(body).toContain('id="stage"');
    // no CSS hides the feed/stage per mode.
    expect(body).not.toMatch(/\[data-mode=[^\]]*\]\s*#jobList\s*\{[^}]*display:\s*none/);
    expect(body).not.toMatch(/\[data-mode=[^\]]*\]\s*#stage\s*\{[^}]*display:\s*none/);
  });

  it("UI qualities: autofocus, theme tokens, narrow-width handling, reduced-motion, visible focus (A20)", () => {
    const body = servedBody();
    // (a) the prompt receives focus on conduct-mode entry/boot AND the focus survives the async
    // /projects load: refreshProjects re-focuses via the view's focusPrompt seam after the rebuild.
    expect(body).toMatch(/function focusDeckPrompt\(/);
    expect(body).toMatch(/if \(mode === ["']conduct["']\) focusDeckPrompt\(\)/);
    expect(body).toMatch(/focusPrompt\(\)\s*\{\s*focusDeckPrompt\(\)/);
    expect(body).toMatch(/deps\.view\.focusPrompt\(\)/);
    // (b) deck/mode CSS uses the shared theme tokens and the light theme covers it.
    expect(body).toMatch(/\.deck-prompt\s*\{[^}]*var\(--/);
    expect(body).toMatch(/\.mode-switch\b[^{]*\{[^}]*var\(--/);
    expect(body).toMatch(/:root\[data-theme=["']light["']\]/);
    // (c) narrow-width handling for the deck (media query + wrap, no fixed px width forcing overflow).
    expect(body).toMatch(/@media\s*\(max-width:\s*820px\)/);
    const deckRules = body.match(/\.deck[\w-]*\s*\{[^}]*\}/g) ?? [];
    for (const rule of deckRules) expect(rule).not.toMatch(/\bwidth\s*:\s*\d+px/);
    // (d) animations/transitions gated by prefers-reduced-motion.
    expect(body).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
    // (e) visible keyboard focus on the switch + deck controls (focus-visible), no bare outline:none.
    expect(body).toMatch(/\.mode-switch button:focus-visible\s*\{[^}]*outline/);
    expect(body).toMatch(/:focus-visible\s*\{[^}]*outline/);
  });

  it("the mode posture is persisted via localStorage in the boot layer (grep hit)", () => {
    const body = servedBody();
    expect(body).toContain("localStorage");
    expect(body).toMatch(/getMode\s*\(\)/);
    expect(body).toMatch(/setMode\s*\(/);
  });
});
