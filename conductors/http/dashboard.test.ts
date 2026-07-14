/**
 * `conductors/http/dashboard.test.ts` — U4: the Sparra Bridge Console.
 *
 * DI, no socket, no DOM: imports `dashboard.client.js` directly and drives its API/controller layer
 * with a fake `fetch` + fake `storage`/`view`; drives `handlers/dashboard.ts`'s `GET /` handler with
 * an injected asset reader. Also scans the served body structurally (self-contained, responsive,
 * theme/no-Anthropic-colors).
 */
import vm from "node:vm";

import { describe, expect, it, vi } from "vitest";

import {
  API_ENDPOINTS,
  CONSOLE_MODES,
  DEFAULT_CONSOLE_MODE,
  apiCall,
  applyEvents,
  applyJobFeed,
  applyStage,
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
  logAtBottom,
  normalizeMode,
  planJobFeed,
  planStage,
  pollEvents,
  pollJob,
  projectSummary,
  rehydrateJobs,
  refreshHealth,
  refreshProjects,
  resolveLogScroll,
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
import type { JobRowView, StageSnapshot } from "./dashboard.client.js";
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
    rehydrateJobs: vi.fn(),
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
  // GET /events (the cursor-delta lifecycle feed shared across ALL jobs — conductors/http/events.ts) IS
  // now consumed by the dashboard: `pollEvents` fetches it once per poll tick and folds the delta into
  // the tracked job state (see `applyEvents` below), replacing the old per-running-job `GET /jobs/:id`
  // sweep. `GET /jobs/:id` itself is KEPT — polled only for the currently-selected RUNNING job's detail
  // stage (streaming phase log + full `pendingDecisions` projection), neither of which `/events` carries.
  it("lists exactly the documented endpoints", () => {
    const set = API_ENDPOINTS.map((e: { method: string; path: string }) => `${e.method} ${e.path}`).sort();
    expect(set).toEqual(
      [
        "GET /health",
        "GET /projects",
        "GET /jobs",
        "GET /events",
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

  it("accepts a `?since=<cursor>` query on the STATIC GET /events endpoint (no `:id` segment)", () => {
    const { url } = buildRequest("GET", "/events?since=5", { token: TOKEN });
    expect(url).toBe("/events?since=5");
    expect(() => buildRequest("GET", "/events?since=0", { token: TOKEN })).not.toThrow();
  });

  it("a query string on a NON-allowlisted path is still rejected (no allowlist regression)", () => {
    expect(() => buildRequest("GET", "/evil?since=5", { token: TOKEN })).toThrow();
  });

  it("a fragment on GET /events is still rejected (fragment never allowed, query or not)", () => {
    expect(() => buildRequest("GET", "/events#frag", { token: TOKEN })).toThrow();
    expect(() => buildRequest("GET", "/events?since=5#frag", { token: TOKEN })).toThrow();
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

// --- blink-free change-detection: pure render-plan helpers + fake appliers -----------------------
//
// These drive the SAME pure helpers `dashboard.html`'s inline appliers consult, through fake appliers
// whose per-region spies (job list / animation / stage shell / elapsed node / log node) let us count
// REAL write calls. No browser, no network — the whole point is that an identical poll performs ZERO
// writes (no blink), a tick touches only the elapsed node, and the log node survives unrelated updates.

/** A fake job-feed applier: one spy per write path (list markup+count, per-row entrance animation). */
function fakeJobApplier() {
  return {
    writeJobList: vi.fn((_rows: JobRowView[], _newRowIds: string[]) => {}),
    animateRow: vi.fn((_id: string) => {}),
  };
}

/** A fake detail-stage applier: one spy per region, plus a PERSISTENT `logNode` fixture so we can
 *  assert the log node's identity + scroll state survive shell-only updates (it's replaced ONLY when
 *  `writeLog` is actually called). */
function fakeStageApplier() {
  const logNode = { scrollTop: 0, scrollHeight: 200, clientHeight: 50, content: "" };
  return {
    logNode,
    resetStage: vi.fn((_next: StageSnapshot) => {}),
    writeStageShell: vi.fn((_next: StageSnapshot) => {}),
    writeElapsed: vi.fn((_text: string | undefined) => {}),
    writeLog: vi.fn((next: StageSnapshot) => {
      logNode.content = String(next.logText ?? "");
    }),
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function clearSpies(applier: Record<string, any>) {
  for (const v of Object.values(applier)) if (v && typeof v.mockClear === "function") v.mockClear();
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function row(id: string, sig: string): JobRowView {
  return { id, sig, html: `<div data-job-id="${id}">${sig}</div>` };
}

/** A job-mode stage snapshot; `over` mutates one region for the delta tests. */
function jobStage(over: Partial<StageSnapshot> = {}): StageSnapshot {
  return {
    key: "job:j1",
    hasElapsed: true,
    hasLog: true,
    shellSig: "shell-v1",
    shellHtml: "<shell/>",
    termHeadHtml: "<termhead/>",
    logSig: "log-v1",
    logText: "log-v1",
    elapsed: "1s",
    elapsedText: "1s",
    ...over,
  };
}

describe("job-feed change-detection (applyJobFeed / planJobFeed)", () => {
  it("no-op: a second deep-equal render performs ZERO applier writes", () => {
    const applier = fakeJobApplier();
    let displayed = applyJobFeed(applier, undefined, [row("j1", "a"), row("j2", "b")]);
    expect(applier.writeJobList).toHaveBeenCalledTimes(1); // first render writes
    expect(applier.animateRow).toHaveBeenCalledTimes(2); // both rows first-appearing

    clearSpies(applier);
    // A FRESH, structurally-identical array (deep-equal, new object refs) must still be a no-op.
    displayed = applyJobFeed(applier, displayed, [row("j1", "a"), row("j2", "b")]);
    expect(applier.writeJobList).not.toHaveBeenCalled();
    expect(applier.animateRow).not.toHaveBeenCalled();
  });

  it("changed state (a row's status sig) → re-render occurs, but no already-visible row re-animates", () => {
    const applier = fakeJobApplier();
    let displayed = applyJobFeed(applier, undefined, [row("j1", "running")]);
    clearSpies(applier);

    displayed = applyJobFeed(applier, displayed, [row("j1", "succeeded")]);
    expect(applier.writeJobList).toHaveBeenCalledTimes(1);
    expect(applier.animateRow).not.toHaveBeenCalled(); // j1 was already visible → no entrance animation
  });

  it("first appearance animates the NEW row only (existing rows never re-animate)", () => {
    const applier = fakeJobApplier();
    let displayed = applyJobFeed(applier, undefined, [row("j1", "a")]);
    expect(applier.animateRow).toHaveBeenCalledWith("j1");
    clearSpies(applier);

    // j2 appears at the head; j1 unchanged.
    displayed = applyJobFeed(applier, displayed, [row("j2", "b"), row("j1", "a")]);
    expect(applier.writeJobList).toHaveBeenCalledTimes(1);
    expect(applier.animateRow).toHaveBeenCalledTimes(1);
    expect(applier.animateRow).toHaveBeenCalledWith("j2");

    // planJobFeed pins newRowIds directly, too.
    const plan = planJobFeed([row("j1", "a")], [row("j2", "b"), row("j1", "a")]);
    expect(plan.changed).toBe(true);
    expect(plan.newRowIds).toEqual(["j2"]);
  });

  it("list membership change (a row drops out) re-renders", () => {
    const applier = fakeJobApplier();
    let displayed = applyJobFeed(applier, undefined, [row("j1", "a"), row("j2", "b")]);
    clearSpies(applier);
    displayed = applyJobFeed(applier, displayed, [row("j1", "a")]); // j2 gone
    expect(applier.writeJobList).toHaveBeenCalledTimes(1);
    expect(applier.animateRow).not.toHaveBeenCalled();
  });
});

describe("detail-stage change-detection (applyStage / planStage)", () => {
  it("no-op: a second deep-equal render performs ZERO applier writes", () => {
    const applier = fakeStageApplier();
    let displayed = applyStage(applier, undefined, jobStage());
    // first render = mount: skeleton + all three regions written once.
    expect(applier.resetStage).toHaveBeenCalledTimes(1);
    expect(applier.writeStageShell).toHaveBeenCalledTimes(1);
    expect(applier.writeElapsed).toHaveBeenCalledTimes(1);
    expect(applier.writeLog).toHaveBeenCalledTimes(1);

    clearSpies(applier);
    displayed = applyStage(applier, displayed, jobStage());
    expect(applier.resetStage).not.toHaveBeenCalled();
    expect(applier.writeStageShell).not.toHaveBeenCalled();
    expect(applier.writeElapsed).not.toHaveBeenCalled();
    expect(applier.writeLog).not.toHaveBeenCalled();
  });

  it("log-only delta → ONLY the log region is written", () => {
    const applier = fakeStageApplier();
    let displayed = applyStage(applier, undefined, jobStage());
    clearSpies(applier);

    displayed = applyStage(applier, displayed, jobStage({ logSig: "log-v2", logText: "log-v2" }));
    expect(applier.writeLog).toHaveBeenCalledTimes(1);
    expect(applier.writeStageShell).not.toHaveBeenCalled();
    expect(applier.writeElapsed).not.toHaveBeenCalled();
    expect(applier.resetStage).not.toHaveBeenCalled();
  });

  it("status/decision (shell) delta with identical log → log node NOT written, identity + scroll retained", () => {
    const applier = fakeStageApplier();
    const nodeBefore = applier.logNode;
    let displayed = applyStage(applier, undefined, jobStage());
    // model a reader having scrolled the log after mount:
    applier.logNode.scrollTop = 42;
    clearSpies(applier);

    displayed = applyStage(applier, displayed, jobStage({ shellSig: "shell-v2", shellHtml: "<shell2/>" }));
    expect(applier.writeStageShell).toHaveBeenCalledTimes(1);
    expect(applier.writeLog).not.toHaveBeenCalled(); // log-write spy at 0
    expect(applier.logNode).toBe(nodeBefore); // same node object retained
    expect(applier.logNode.scrollTop).toBe(42); // scroll state preserved
    // a shell rewrite recreates the elapsed node, so elapsed is (re)written — but the log is not.
    expect(applier.writeElapsed).toHaveBeenCalledTimes(1);
  });

  it("elapsed-only tick → ONLY the elapsed node's text changes; every other region at 0", () => {
    const applier = fakeStageApplier();
    let displayed = applyStage(applier, undefined, jobStage());
    clearSpies(applier);

    displayed = applyStage(applier, displayed, jobStage({ elapsed: "2s", elapsedText: "2s" }));
    expect(applier.writeElapsed).toHaveBeenCalledTimes(1);
    expect(applier.writeElapsed).toHaveBeenCalledWith("2s");
    expect(applier.writeStageShell).not.toHaveBeenCalled();
    expect(applier.writeLog).not.toHaveBeenCalled();
    expect(applier.resetStage).not.toHaveBeenCalled();
  });

  it("subject change (a different selected job) remounts the stage skeleton", () => {
    const applier = fakeStageApplier();
    let displayed = applyStage(applier, undefined, jobStage());
    clearSpies(applier);
    displayed = applyStage(applier, displayed, jobStage({ key: "job:j2" }));
    expect(applier.resetStage).toHaveBeenCalledTimes(1);
    expect(applier.writeStageShell).toHaveBeenCalledTimes(1);
  });
});

describe("log scroll follow/preserve (logAtBottom / resolveLogScroll)", () => {
  it("at-bottom before the write → scrolls to the new tail after", () => {
    const node = { scrollTop: 150, scrollHeight: 200, clientHeight: 50 }; // 200-150-50 = 0 → at bottom
    const wasAtBottom = logAtBottom(node);
    expect(wasAtBottom).toBe(true);
    node.scrollHeight = 500; // a new log line grew the content
    expect(resolveLogScroll(node, wasAtBottom, 150)).toBe(500); // followed the tail
  });

  it("scrolled up before the write → offset preserved after", () => {
    const node = { scrollTop: 20, scrollHeight: 200, clientHeight: 50 }; // 200-20-50 = 130 → not bottom
    const wasAtBottom = logAtBottom(node);
    expect(wasAtBottom).toBe(false);
    node.scrollHeight = 500;
    expect(resolveLogScroll(node, wasAtBottom, 20)).toBe(20); // preserved the reader's position
  });
});

describe("mutation check: neutering the signature comparison is caught by the oracles", () => {
  it("an always-'changed' comparator writes on an identical render (no-op oracle rejects it)", () => {
    const alwaysChanged = () => false;

    // Honest comparator: identical render is a no-op (control).
    const honest = fakeJobApplier();
    const displayed = applyJobFeed(honest, undefined, [row("j1", "a")]);
    clearSpies(honest);
    applyJobFeed(honest, displayed, [row("j1", "a")]);
    expect(honest.writeJobList).not.toHaveBeenCalled();

    // Mutant: same identical render, but the compare is neutered → it wrongly writes → REJECTED.
    const mutant = fakeJobApplier();
    const displayed2 = applyJobFeed(mutant, undefined, [row("j1", "a")]);
    clearSpies(mutant);
    applyJobFeed(mutant, displayed2, [row("j1", "a")], { equal: alwaysChanged });
    expect(mutant.writeJobList).toHaveBeenCalled(); // the no-op test would fail under this mutant
  });

  it("an always-'unchanged' comparator misses a real change (changed-state oracle rejects it)", () => {
    const alwaysUnchanged = () => true;
    const changed = jobStage({ shellSig: "shell-v2", logSig: "log-v2", logText: "log-v2" });

    // Honest comparator: a real change IS written (control).
    const honest = fakeStageApplier();
    const displayed = applyStage(honest, undefined, jobStage());
    clearSpies(honest);
    applyStage(honest, displayed, changed);
    expect(honest.writeStageShell).toHaveBeenCalled();
    expect(honest.writeLog).toHaveBeenCalled();

    // Mutant: the compare always says "equal" → the real change is dropped → REJECTED.
    const mutant = fakeStageApplier();
    const displayed2 = applyStage(mutant, undefined, jobStage());
    clearSpies(mutant);
    applyStage(mutant, displayed2, changed, { equal: alwaysUnchanged });
    expect(mutant.writeStageShell).not.toHaveBeenCalled(); // the changed-state test would fail under this mutant
    expect(mutant.writeLog).not.toHaveBeenCalled();
  });
});

// --- the served page actually wires the blink-free path -----------------------------------------

describe("the real served page consults the change-detection helpers (no ad-hoc re-render)", () => {
  function servedBody(): string {
    const routes = createDashboardRoutes();
    const handler = getHandler(routes, "GET", "/");
    const result = handler(fakeCtx({ dashboard: true })) as { status: number; html?: string };
    expect(result.status).toBe(200);
    return result.html!;
  }

  it("renderJobs/renderStage apply the helper plans; the elapsed counter has its own node", () => {
    const body = servedBody();
    // The inlined client exposes the pure helpers…
    expect(body).toMatch(/function planJobFeed\(/);
    expect(body).toMatch(/function planStage\(/);
    // …and the page's render functions consult them (no wholesale unconditional innerHTML re-render).
    expect(body).toMatch(/applyJobFeed\(/);
    expect(body).toMatch(/applyStage\(/);
    // the elapsed counter is its own textContent-updated node (requirement 2).
    expect(body).toContain('id="elapsedVal"');
    // the persistent log node survives shell rewrites.
    expect(body).toContain('id="termBody"');
    // job rows no longer carry an inline entrance animation that would re-fire every poll.
    expect(body).not.toMatch(/class="job [^"]*"[^>]*style="animation:rise/);
  });
});

// --- rehydrateJobs controller (GET /jobs → view.rehydrateJobs) ----------------------------------

describe("rehydrateJobs — the GET /jobs listing → feed rehydration controller", () => {
  it("fetches GET /jobs and hands the projected listing to view.rehydrateJobs", async () => {
    const serverJobs = [
      { id: "j2", kind: "conduct", status: "running", createdAt: 3, pendingDecisions: [{ seq: 1, unit: "u", kind: "k", question: "Q", options: ["a", "b"], default: "a", expiresAt: "z", secret: "SHOULD-BE-DROPPED" }] },
      { id: "j1", kind: "build", status: "succeeded", createdAt: 1 },
    ];
    let calledUrl = "";
    const fetchImpl = vi.fn(async (url: string) => {
      calledUrl = url;
      return jsonResponse(200, serverJobs);
    });
    const view = fakeView();
    await rehydrateJobs({ storage: fakeStorage(TOKEN), view, fetchImpl });
    expect(calledUrl).toBe("/jobs");
    expect(view.rehydrateJobs).toHaveBeenCalledOnce();
    const handed = view.rehydrateJobs.mock.calls[0]![0] as any[]; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(handed.map((j) => j.id)).toEqual(["j2", "j1"]);
    // pendingDecisions were re-projected (defense in depth): the planted extra field is gone.
    expect(JSON.stringify(handed)).not.toContain("SHOULD-BE-DROPPED");
    expect(handed[0].pendingDecisions[0]).toEqual({ seq: 1, unit: "u", kind: "k", question: "Q", options: ["a", "b"], default: "a", expiresAt: "z" });
  });

  it("a 401 routes to re-auth (never populates the feed)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(401, { error: "unauthorized" }));
    const view = fakeView();
    const storage = fakeStorage(TOKEN);
    await rehydrateJobs({ storage, view, fetchImpl });
    expect(view.rehydrateJobs).not.toHaveBeenCalled();
    expect(view.showReauth).toHaveBeenCalled();
    expect(storage.clearToken).toHaveBeenCalled();
  });

  it("a non-array body degrades to an empty feed (no throw)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { not: "an array" }));
    const view = fakeView();
    await rehydrateJobs({ storage: fakeStorage(TOKEN), view, fetchImpl });
    expect(view.rehydrateJobs).toHaveBeenCalledWith([]);
  });
});

// --- pollEvents / applyEvents — the GET /events cursor-delta feed -------------------------------

describe("pollEvents — one GET /events?since=<cursor> per call, cursor advances monotonically", () => {
  it("issues GET /events?since=<current cursor> and advances state.eventCursor to the response cursor", async () => {
    let calledUrl = "";
    const fetchImpl = vi.fn(async (url: string) => {
      calledUrl = url;
      return jsonResponse(200, { events: [{ type: "job_started", jobId: "j1", kind: "build", root: "/a" }], cursor: 7 });
    });
    const view = fakeView() as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    view.applyEvents = vi.fn();
    const state = { eventCursor: 3 };
    await pollEvents({ storage: fakeStorage(TOKEN), view, fetchImpl, state });
    expect(calledUrl).toBe("/events?since=3");
    expect(state.eventCursor).toBe(7);
    expect(view.applyEvents).toHaveBeenCalledWith([{ type: "job_started", jobId: "j1", kind: "build", root: "/a" }]);
  });

  it("defaults to since=0 when state.eventCursor is absent", async () => {
    let calledUrl = "";
    const fetchImpl = vi.fn(async (url: string) => {
      calledUrl = url;
      return jsonResponse(200, { events: [], cursor: 0 });
    });
    const view = fakeView() as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    view.applyEvents = vi.fn();
    await pollEvents({ storage: fakeStorage(TOKEN), view, fetchImpl, state: {} });
    expect(calledUrl).toBe("/events?since=0");
  });

  it("an EMPTY events:[] delta does NOT regress the cursor (advances, never goes backward)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { events: [], cursor: 12 }));
    const view = fakeView() as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    view.applyEvents = vi.fn();
    const state = { eventCursor: 12 };
    await pollEvents({ storage: fakeStorage(TOKEN), view, fetchImpl, state });
    expect(state.eventCursor).toBe(12);
    expect(view.applyEvents).toHaveBeenCalledWith([]);

    // A stale/out-of-order response reporting a cursor STRICTLY BELOW the current LIVE cursor must be
    // discarded WHOLESALE — no cursor write, no `applyEvents` call at all (not merely "clamped").
    view.applyEvents.mockClear();
    const fetchStale = vi.fn(async () => jsonResponse(200, { events: [{ type: "job_done", jobId: "j1", status: "running" }], cursor: 4 }));
    await pollEvents({ storage: fakeStorage(TOKEN), view, fetchImpl: fetchStale, state });
    expect(state.eventCursor).toBe(12);
    expect(view.applyEvents).not.toHaveBeenCalled();
  });

  it("a 401 routes to re-auth and never calls view.applyEvents", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(401, { error: "unauthorized" }));
    const view = fakeView() as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    view.applyEvents = vi.fn();
    const storage = fakeStorage(TOKEN);
    const state = { eventCursor: 0 };
    await pollEvents({ storage, view, fetchImpl, state });
    expect(view.applyEvents).not.toHaveBeenCalled();
    expect(view.showReauth).toHaveBeenCalled();
    expect(storage.clearToken).toHaveBeenCalled();
  });

  // --- CURSOR RACE: an out-of-order (late/slower) response must never regress state (pivot fix) -----

  it("RACE: an older response resolving AFTER a newer one settled is discarded — cursor/job never regress", async () => {
    // Two overlapping pollEvents calls share the SAME `state` (as two ticks racing over a slow bridge
    // would): the OLDER request (captured cursor=0, would advance to cursor=1, job → "running") is
    // slower and resolves SECOND; the NEWER request (also captured cursor=0, advances to cursor=2, job
    // → "succeeded") is faster and resolves FIRST. The older response's cursor (1) is now BELOW the
    // live cursor (2) by the time it lands — it must be discarded wholesale: neither the cursor nor the
    // job's status may roll backward.
    const view = fakeView() as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    const jobs = new Map<string, any>([["j1", { id: "j1", kind: "build", root: "/r", status: "running" }]]); // eslint-disable-line @typescript-eslint/no-explicit-any
    let order = ["j1"];
    view.applyEvents = vi.fn((events: any[]) => {
      // eslint-disable-line @typescript-eslint/no-explicit-any
      const folded = applyEvents(jobs, order, events);
      jobs.clear();
      for (const [id, job] of folded.jobs) jobs.set(id, job);
      order = folded.order;
    });
    const state = { eventCursor: 0 };
    const storage = fakeStorage(TOKEN);

    let resolveOlder!: (v: unknown) => void;
    const olderPending = new Promise((resolve) => {
      resolveOlder = resolve;
    });
    const fetchOlder = vi.fn(() => olderPending.then(() => jsonResponse(200, { events: [{ type: "job_done", jobId: "j1", status: "running" }], cursor: 1 })));
    const fetchNewer = vi.fn(async () => jsonResponse(200, { events: [{ type: "job_done", jobId: "j1", status: "succeeded" }], cursor: 2 }));

    // Fire the OLDER (slower) call first, WITHOUT awaiting it — it will resolve only once we release
    // `resolveOlder` below, simulating it being the slower of the two overlapping requests.
    const olderCall = pollEvents({ storage, view, fetchImpl: fetchOlder, state });
    // The NEWER (faster) call fires and fully resolves BEFORE the older one settles.
    await pollEvents({ storage, view, fetchImpl: fetchNewer, state });
    expect(state.eventCursor).toBe(2);
    expect(jobs.get("j1")!.status).toBe("succeeded");

    // Now let the older, slower response land.
    resolveOlder(undefined);
    await olderCall;

    // The older response must have been discarded WHOLESALE: the cursor stays at 2 (never regresses to
    // 1) and the job stays "succeeded" (never rolled back to "running").
    expect(state.eventCursor).toBe(2);
    expect(jobs.get("j1")!.status).toBe("succeeded");
    // applyEvents was invoked exactly once (for the newer batch) — the discarded older response never
    // reached the view/reducer layer at all.
    expect(view.applyEvents).toHaveBeenCalledTimes(1);
  });
});

describe("applyEvents — pure reducer folding an /events delta onto tracked job state", () => {
  it("job_started for an UNKNOWN id adds a minimal running row", () => {
    const { jobs, order } = applyEvents(new Map(), [], [{ type: "job_started", jobId: "new-1", kind: "build", root: "/r" }]);
    expect(jobs.get("new-1")).toEqual({ id: "new-1", kind: "build", root: "/r", status: "running" });
    expect(order).toEqual(["new-1"]);
  });

  it("job_started for a KNOWN id keeps/sets running without touching other fields", () => {
    const prevJobs = new Map([["j1", { id: "j1", kind: "build", root: "/r", status: "running", log: "hello" }]]);
    const { jobs } = applyEvents(prevJobs, ["j1"], [{ type: "job_started", jobId: "j1", kind: "build", root: "/r" }]);
    expect(jobs.get("j1")).toEqual({ id: "j1", kind: "build", root: "/r", status: "running", log: "hello" });
  });

  it("job_done sets the EXACT terminal status — succeeded / failed / canceled are distinct outcomes", () => {
    const base = new Map([
      ["j-ok", { id: "j-ok", kind: "build", root: "/r", status: "running" }],
      ["j-bad", { id: "j-bad", kind: "build", root: "/r", status: "running" }],
      ["j-cancel", { id: "j-cancel", kind: "build", root: "/r", status: "running" }],
    ]);
    const order = ["j-ok", "j-bad", "j-cancel"];
    const events = [
      { type: "job_done", jobId: "j-ok", status: "succeeded" },
      { type: "job_done", jobId: "j-bad", status: "failed" },
      { type: "job_done", jobId: "j-cancel", status: "canceled" },
    ];
    const { jobs } = applyEvents(base, order, events);
    expect(jobs.get("j-ok")!.status).toBe("succeeded");
    expect(jobs.get("j-bad")!.status).toBe("failed");
    expect(jobs.get("j-cancel")!.status).toBe("canceled");
  });

  it("decision_parked attaches a {seq, question} marker into pendingDecisions (feed badge reflects it)", () => {
    const base = new Map([["j1", { id: "j1", kind: "conduct", root: "/r", status: "running" }]]);
    const { jobs } = applyEvents(base, ["j1"], [{ type: "decision_parked", jobId: "j1", seq: 3, question: "merge?" }]);
    expect(jobs.get("j1")!.pendingDecisions).toEqual([{ seq: 3, question: "merge?" }]);
  });

  it("decision_parked is additive to an existing FULL pendingDecisions entry from a /jobs/:id projection", () => {
    const base = new Map([
      [
        "j1",
        {
          id: "j1",
          kind: "conduct",
          root: "/r",
          status: "running",
          pendingDecisions: [{ seq: 1, unit: "u", kind: "k", question: "first?", options: ["a", "b"], default: "a", expiresAt: "z" }],
        },
      ],
    ]);
    const { jobs } = applyEvents(base, ["j1"], [{ type: "decision_parked", jobId: "j1", seq: 2, question: "second?" }]);
    expect(jobs.get("j1")!.pendingDecisions).toEqual([
      { seq: 1, unit: "u", kind: "k", question: "first?", options: ["a", "b"], default: "a", expiresAt: "z" },
      { seq: 2, question: "second?" },
    ]);
  });

  it("an unrecognized event type, or an event missing jobId, is tolerated (no throw, no state change)", () => {
    const base = new Map([["j1", { id: "j1", kind: "build", root: "/r", status: "running" }]]);
    expect(() =>
      applyEvents(base, ["j1"], [
        { type: "some_future_event", jobId: "j1" },
        { type: "job_done", status: "succeeded" }, // no jobId
        null,
        undefined,
      ] as any), // eslint-disable-line @typescript-eslint/no-explicit-any
    ).not.toThrow();
    const { jobs, order } = applyEvents(base, ["j1"], [{ type: "some_future_event", jobId: "j1" }] as any); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(jobs.get("j1")).toEqual({ id: "j1", kind: "build", root: "/r", status: "running" });
    expect(order).toEqual(["j1"]);
  });

  it("is idempotent: re-applying the SAME batch yields deep-equal state (no duplicate rows/markers)", () => {
    const events = [
      { type: "job_started", jobId: "new-1", kind: "build", root: "/r" },
      { type: "job_done", jobId: "done-1", status: "succeeded" },
      { type: "decision_parked", jobId: "j1", seq: 1, question: "Q?" },
    ];
    const once = applyEvents(new Map(), [], events);
    const twice = applyEvents(once.jobs, once.order, events);
    expect(Array.from(twice.jobs.entries())).toEqual(Array.from(once.jobs.entries()));
    expect(twice.order).toEqual(once.order);
  });

  it("is idempotent atop a rehydrateJobs snapshot: the since=0 seed batch never double-counts", () => {
    // Simulate: GET /jobs rehydration already populated a job, then the since=0 GET /events batch
    // reports the SAME job's lifecycle — applying it must not create a duplicate row or pending marker.
    const rehydrated = new Map([
      ["j1", { id: "j1", kind: "conduct", root: "/r", status: "running", pendingDecisions: [{ seq: 1, unit: "u", kind: "k", question: "Q?", options: ["a"], default: "a", expiresAt: "z" }] }],
    ]);
    const order = ["j1"];
    const seedBatch = [
      { type: "job_started", jobId: "j1", kind: "conduct", root: "/r" },
      { type: "decision_parked", jobId: "j1", seq: 1, question: "Q?" },
    ];
    const { jobs, order: order2 } = applyEvents(rehydrated, order, seedBatch);
    expect(order2).toEqual(["j1"]); // no duplicate row
    expect(jobs.get("j1")!.pendingDecisions).toHaveLength(1); // marker replaced, not duplicated
    expect(jobs.get("j1")!.status).toBe("running");
  });

  it("does not mutate its inputs (prevJobs Map / prevOrder array both left untouched)", () => {
    const prevJobs = new Map([["j1", { id: "j1", kind: "build", root: "/r", status: "running" }]]);
    const prevOrder = ["j1"];
    applyEvents(prevJobs, prevOrder, [{ type: "job_done", jobId: "j1", status: "succeeded" }]);
    expect(prevJobs.get("j1")!.status).toBe("running"); // original Map entry unchanged
    expect(prevOrder).toEqual(["j1"]);
  });
});

describe("events batch flows through the SAME blink-free planJobFeed/applyJobFeed appliers", () => {
  function toRows(jobs: Map<string, any>, order: string[]) {
    // eslint-disable-line @typescript-eslint/no-explicit-any
    return order.map((id) => {
      const j = jobs.get(id);
      return { id, sig: JSON.stringify({ status: j.status, pending: (j.pendingDecisions || []).length }), html: `<div>${id}</div>` };
    });
  }

  it("a status-changing events batch -> planJobFeed changed:true, applier writes once", () => {
    const prevJobs = new Map([["j1", { id: "j1", kind: "build", root: "/r", status: "running" }]]);
    const prevOrder = ["j1"];
    const prevRows = toRows(prevJobs, prevOrder);
    const { jobs, order } = applyEvents(prevJobs, prevOrder, [{ type: "job_done", jobId: "j1", status: "succeeded" }]);
    const nextRows = toRows(jobs, order);
    const applier = fakeJobApplier();
    applyJobFeed(applier, prevRows, nextRows);
    expect(applier.writeJobList).toHaveBeenCalledTimes(1);
  });

  it("an EMPTY events:[] delta -> planJobFeed changed:false -> ZERO DOM writes (no-op invariant survives the migration)", () => {
    const prevJobs = new Map([["j1", { id: "j1", kind: "build", root: "/r", status: "running" }]]);
    const prevOrder = ["j1"];
    const prevRows = toRows(prevJobs, prevOrder);
    const { jobs, order } = applyEvents(prevJobs, prevOrder, []);
    const nextRows = toRows(jobs, order);
    const applier = fakeJobApplier();
    applyJobFeed(applier, prevRows, nextRows);
    expect(applier.writeJobList).not.toHaveBeenCalled();
    expect(applier.animateRow).not.toHaveBeenCalled();
  });
});

// --- VM-executed served boot path: rehydration, deep-link, poll ---------------------------------
//
// These tests run the REAL served dashboard page's `<script type="module">` (the inlined
// dashboard.client.js + the boot/view/DOM-adapter layer) inside `node:vm` against injected DOM /
// window / fetch / storage / timer shims — exercising `boot()` end-to-end, not a bare exported
// helper. A tiny epilogue (test-only, appended to the extracted script) surfaces the in-scope
// bindings so assertions can observe state/selection after the real boot path ran.
/* eslint-disable @typescript-eslint/no-explicit-any */
describe("served boot path in node:vm — rehydration, deep-link, poll (assertions 7-12)", () => {
  function servedPage(): string {
    const routes = createDashboardRoutes();
    const route = routes.find((r) => r.method === "GET" && r.path === "/")!;
    const result = route.handler(fakeCtx({ dashboard: true })) as { html?: string };
    return result.html!;
  }
  function moduleScript(): string {
    const m = /<script type="module">([\s\S]*?)<\/script>/.exec(servedPage());
    if (!m || m[1] === undefined) throw new Error("served page has no module script");
    // Strip the ESM `export` keywords so the module runs as a classic script in the vm context
    // (the file has NO imports and no re-exports, so the boot code's local bindings are unchanged).
    return m[1].replace(/^export\s+/gm, "");
  }

  interface VMOpts {
    token?: string;
    hash?: string;
    mode?: string;
    respond: (url: string, method: string) => { status: number; data: unknown };
  }

  function makeEnv(opts: VMOpts) {
    const writes = { count: 0 };
    const fetchCalls: Array<{ url: string; method: string }> = [];
    const winListeners: Record<string, Array<() => void>> = {};
    const intervals = new Map<number, () => void>();
    let timerId = 1;
    const elements = new Map<string, any>();

    function makeEl(id = ""): any {
      const el: any = {
        id,
        style: {},
        dataset: {},
        value: "",
        _inner: "",
        _text: "",
        _attrs: {} as Record<string, string>,
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        addEventListener() {},
        removeEventListener() {},
        querySelector() { return makeEl(); },
        querySelectorAll() { return []; },
        closest() { return null; },
        appendChild() {},
        removeChild() {},
        setAttribute(k: string, v: string) { this._attrs[k] = v; },
        removeAttribute(k: string) { delete this._attrs[k]; },
        getAttribute(k: string) { return this._attrs[k]; },
        matches() { return false; },
        contains() { return true; },
        focus() {},
      };
      Object.defineProperty(el, "innerHTML", {
        get() { return el._inner; },
        set(v: unknown) { el._inner = String(v); writes.count++; },
      });
      Object.defineProperty(el, "textContent", {
        get() { return el._text; },
        set(v: unknown) { el._text = String(v); writes.count++; },
      });
      return el;
    }

    const document = {
      getElementById(id: string) {
        if (!elements.has("#" + id)) elements.set("#" + id, makeEl(id));
        return elements.get("#" + id);
      },
      querySelector(sel: string) {
        if (!elements.has("q:" + sel)) elements.set("q:" + sel, makeEl(sel));
        return elements.get("q:" + sel);
      },
      querySelectorAll() { return []; },
      createElement() { return makeEl(); },
      documentElement: makeEl("html"),
      addEventListener() {},
    };

    const location = { hash: opts.hash ?? "", pathname: "/", search: "" };
    const sessionData = new Map<string, string>();
    if (opts.token !== undefined) sessionData.set("sparra-bridge-token", opts.token);
    const localData = new Map<string, string>();
    if (opts.mode !== undefined) localData.set("sparra-bridge-mode", opts.mode);
    const mkStore = (m: Map<string, string>) => ({
      getItem(k: string) { return m.has(k) ? m.get(k) : null; },
      setItem(k: string, v: string) { m.set(k, String(v)); },
      removeItem(k: string) { m.delete(k); },
    });

    const window: any = {
      addEventListener(type: string, cb: () => void) { (winListeners[type] ||= []).push(cb); },
      removeEventListener() {},
      location,
      history: { replaceState() {} },
      matchMedia() { return { matches: false }; },
    };

    async function fetchImpl(url: string, init: any) {
      const method = (init && init.method) || "GET";
      fetchCalls.push({ url, method });
      const { status, data } = opts.respond(url, method);
      return { status, ok: status >= 200 && status < 300, json: async () => data };
    }

    const globals: any = {
      document,
      window,
      location,
      fetch: fetchImpl,
      console: { log() {}, warn() {}, error() {} },
      sessionStorage: mkStore(sessionData),
      localStorage: mkStore(localData),
      matchMedia: window.matchMedia,
      setInterval(cb: () => void) { const id = timerId++; intervals.set(id, cb); return id; },
      clearInterval(id: number) { intervals.delete(id); },
      setTimeout() { return 0; },
      clearTimeout() {},
    };

    return {
      globals,
      writes,
      fetchCalls,
      location,
      localData,
      tick() { for (const cb of [...intervals.values()]) cb(); },
      intervalCount() { return intervals.size; },
      fireWindow(type: string) { for (const cb of [...(winListeners[type] || [])]) cb(); },
      getEl(id: string) { return document.getElementById(id); },
    };
  }

  const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

  const EPILOGUE =
    "\n;globalThis.__vm = { state, view, storage, boot, submitAuth, selectJob, restoreHashSelection, rehydrateJobs, ensurePolling, controllerDeps };";

  async function boot(opts: VMOpts) {
    const env = makeEnv(opts);
    const sandbox: any = vm.createContext(env.globals);
    vm.runInContext(moduleScript() + EPILOGUE, sandbox);
    await flush();
    return { env, api: sandbox.__vm as any };
  }

  const RUNNING_FEED: VMOpts["respond"] = (url) => {
    if (url === "/health") return { status: 200, data: { ok: true } };
    if (url === "/projects") return { status: 200, data: { projects: [] } };
    if (url === "/jobs") {
      return {
        status: 200,
        data: [
          { id: "job-c", kind: "conduct", root: "/r", status: "running", createdAt: 3000, pendingDecisions: [{ seq: 1, unit: "u", kind: "k", question: "Q?", options: ["a", "b"], default: "a", expiresAt: "z" }] },
          { id: "job-b", kind: "reflect", root: "/r", status: "succeeded", createdAt: 2000 },
          { id: "job-a", kind: "build", root: "/r", status: "failed", createdAt: 1000 },
        ],
      };
    }
    if (url.startsWith("/events")) return { status: 200, data: { events: [], cursor: 0 } };
    return { status: 404, data: { error: "not found" } };
  };

  it("(7a) stored token → boot fetches GET /jobs and populates the real feed via applyJobFeed", async () => {
    const { env, api } = await boot({ token: TOKEN, respond: RUNNING_FEED });
    expect(env.fetchCalls.some((c) => c.url === "/jobs" && c.method === "GET")).toBe(true);
    // The feed reflects server order (newest-first as served) and status/awaiting badges.
    const feedHtml = env.getEl("jobList").innerHTML as string;
    expect(feedHtml.indexOf("job-c")).toBeGreaterThanOrEqual(0);
    expect(feedHtml.indexOf("job-c")).toBeLessThan(feedHtml.indexOf("job-b"));
    expect(feedHtml.indexOf("job-b")).toBeLessThan(feedHtml.indexOf("job-a"));
    expect(feedHtml).toContain("badge-awaiting"); // job-c is parked
    expect(feedHtml).toContain("badge-succeeded");
    expect(feedHtml).toContain("badge-failed");
    expect(api.state.jobOrder).toEqual(["job-c", "job-b", "job-a"]);
  });

  it("(7b) fresh token-entry flow (submitAuth) does the same GET /jobs rehydration", async () => {
    const { env, api } = await boot({ respond: RUNNING_FEED }); // NO stored token → auth prompt
    expect(env.fetchCalls.some((c) => c.url === "/jobs")).toBe(false); // nothing fetched yet
    // Operator types a token and submits.
    env.getEl("tokenInput").value = TOKEN;
    api.submitAuth();
    await flush();
    expect(env.fetchCalls.some((c) => c.url === "/jobs" && c.method === "GET")).toBe(true);
    expect(api.state.jobOrder).toEqual(["job-c", "job-b", "job-a"]);
  });

  it("(8) rehydrating IDENTICAL state over the populated feed performs ZERO DOM writes", async () => {
    const { env, api } = await boot({ token: TOKEN, respond: RUNNING_FEED });
    const before = env.writes.count;
    // Re-feed the EXACT current state through the same view path.
    const same = api.state.jobOrder.map((id: string) => api.state.jobs.get(id));
    api.view.rehydrateJobs(same);
    expect(env.writes.count - before).toBe(0);
  });

  it("(9) a job present only server-side (never triggered on this page) appears after rehydration", async () => {
    // Boot with no jobs, then rehydrate a server-only job — it must appear.
    const respond: VMOpts["respond"] = (url) => {
      if (url === "/health") return { status: 200, data: { ok: true } };
      if (url === "/projects") return { status: 200, data: { projects: [] } };
      if (url === "/jobs") return { status: 200, data: [] };
      return { status: 404, data: {} };
    };
    const { env, api } = await boot({ token: TOKEN, respond });
    expect(api.state.jobOrder).toEqual([]);
    api.view.rehydrateJobs([{ id: "elsewhere-1", kind: "conduct", root: "/r", status: "running", createdAt: 5 }]);
    await flush();
    expect(api.state.jobOrder).toContain("elsewhere-1");
    expect(env.getEl("jobList").innerHTML).toContain("elsewhere-1");
  });

  it("(10) SELECTED running job → recurring 1500ms GET /jobs/:id poll; terminal → polling stops", async () => {
    // U5: `GET /jobs/:id` is now polled per-tick ONLY for the SELECTED running job (the old model
    // polled every tracked running job unconditionally) — so this job must be selected (`#job=job-c`)
    // for the recurring per-job poll to fire at all.
    let jobcStatus = "running";
    const respond: VMOpts["respond"] = (url) => {
      if (url === "/health") return { status: 200, data: { ok: true } };
      if (url === "/projects") return { status: 200, data: { projects: [] } };
      if (url === "/jobs") return { status: 200, data: [{ id: "job-c", kind: "conduct", root: "/r", status: "running", createdAt: 3000 }] };
      if (url === "/jobs/job-c") return { status: 200, data: { id: "job-c", kind: "conduct", root: "/r", status: jobcStatus, log: "" } };
      if (url.startsWith("/events")) return { status: 200, data: { events: [], cursor: 0 } };
      return { status: 404, data: {} };
    };
    const { env, api } = await boot({ token: TOKEN, hash: "#job=job-c", respond });
    expect(api.state.jobOrder).toEqual(["job-c"]);
    expect(api.state.selectedJobId).toBe("job-c");
    const pollCount = () => env.fetchCalls.filter((c) => c.url === "/jobs/job-c").length;
    // Two ticks → two recurring poll fetches for the running job.
    env.tick(); await flush();
    env.tick(); await flush();
    expect(pollCount()).toBeGreaterThanOrEqual(2);
    // Job goes terminal; the next tick observes it and clears the recurring poll.
    jobcStatus = "succeeded";
    env.tick(); await flush(); // this tick polls once more, gets succeeded
    const afterTerminalObserved = pollCount();
    env.tick(); await flush(); // no running jobs now → interval self-clears
    expect(env.intervalCount()).toBe(0);
    const before = pollCount();
    env.tick(); await flush(); // interval gone → no further poll fetches
    expect(pollCount()).toBe(before);
    expect(afterTerminalObserved).toBeGreaterThanOrEqual(3);
  });

  it("(10b) a purely terminal feed schedules NO poll fetch", async () => {
    const respond: VMOpts["respond"] = (url) => {
      if (url === "/health") return { status: 200, data: { ok: true } };
      if (url === "/projects") return { status: 200, data: { projects: [] } };
      if (url === "/jobs") return { status: 200, data: [{ id: "done-1", kind: "build", root: "/r", status: "succeeded", createdAt: 1 }] };
      return { status: 404, data: {} };
    };
    const { env } = await boot({ token: TOKEN, respond });
    // No tracked job is running → ensurePolling must NOT even arm a timer (not
    // merely self-clear on the first tick).
    expect(env.intervalCount()).toBe(0);
    env.tick(); await flush();
    expect(env.intervalCount()).toBe(0);
    expect(env.fetchCalls.filter((c) => c.url.startsWith("/jobs/")).length).toBe(0);
    expect(env.fetchCalls.filter((c) => c.url.startsWith("/events")).length).toBe(0);
  });

  it("(13) tick shape: 3 running jobs + 1 SELECTED running → exactly 1 GET /events + 1 GET /jobs/:id (selected only)", async () => {
    const respond: VMOpts["respond"] = (url) => {
      if (url === "/health") return { status: 200, data: { ok: true } };
      if (url === "/projects") return { status: 200, data: { projects: [] } };
      if (url === "/jobs") {
        return {
          status: 200,
          data: [
            { id: "job-1", kind: "build", root: "/r", status: "running", createdAt: 1 },
            { id: "job-2", kind: "build", root: "/r", status: "running", createdAt: 2 },
            { id: "job-3", kind: "build", root: "/r", status: "running", createdAt: 3 },
          ],
        };
      }
      if (url === "/jobs/job-2") return { status: 200, data: { id: "job-2", kind: "build", root: "/r", status: "running", log: "" } };
      if (url.startsWith("/events")) return { status: 200, data: { events: [], cursor: 0 } };
      return { status: 404, data: {} };
    };
    const { env, api } = await boot({ token: TOKEN, hash: "#job=job-2", respond });
    expect(api.state.selectedJobId).toBe("job-2");
    env.fetchCalls.length = 0; // isolate ONE tick's calls from the boot-time health/projects/jobs fetches
    env.tick();
    await flush();
    const eventsCalls = env.fetchCalls.filter((c) => c.url.startsWith("/events"));
    const jobCalls = env.fetchCalls.filter((c) => c.url.startsWith("/jobs/"));
    expect(eventsCalls).toHaveLength(1);
    expect(jobCalls).toHaveLength(1);
    expect(jobCalls[0]!.url).toBe("/jobs/job-2");
  });

  it("(14) selected-but-terminal contrast: another job runs, selected job is terminal → 1 GET /events, 0 GET /jobs/:id", async () => {
    const respond: VMOpts["respond"] = (url) => {
      if (url === "/health") return { status: 200, data: { ok: true } };
      if (url === "/projects") return { status: 200, data: { projects: [] } };
      if (url === "/jobs") {
        return {
          status: 200,
          data: [
            { id: "job-run", kind: "build", root: "/r", status: "running", createdAt: 2 },
            { id: "job-done", kind: "build", root: "/r", status: "succeeded", createdAt: 1 },
          ],
        };
      }
      if (url.startsWith("/events")) return { status: 200, data: { events: [], cursor: 0 } };
      return { status: 404, data: {} };
    };
    // The SELECTED job (job-done) is terminal; a DIFFERENT job (job-run) is still running — a
    // "selected" job alone must not trigger a per-job poll, only a selected RUNNING job does.
    const { env, api } = await boot({ token: TOKEN, hash: "#job=job-done", respond });
    expect(api.state.selectedJobId).toBe("job-done");
    env.fetchCalls.length = 0;
    env.tick();
    await flush();
    expect(env.fetchCalls.filter((c) => c.url.startsWith("/events"))).toHaveLength(1);
    expect(env.fetchCalls.filter((c) => c.url.startsWith("/jobs/"))).toHaveLength(0);
  });

  it("(15) nothing selected → 1 GET /events, 0 GET /jobs/:id", async () => {
    const respond: VMOpts["respond"] = (url) => {
      if (url === "/health") return { status: 200, data: { ok: true } };
      if (url === "/projects") return { status: 200, data: { projects: [] } };
      if (url === "/jobs") return { status: 200, data: [{ id: "job-run", kind: "build", root: "/r", status: "running", createdAt: 1 }] };
      if (url.startsWith("/events")) return { status: 200, data: { events: [], cursor: 0 } };
      return { status: 404, data: {} };
    };
    const { env, api } = await boot({ token: TOKEN, respond }); // no hash → nothing selected
    expect(api.state.selectedJobId).toBeUndefined();
    env.fetchCalls.length = 0;
    env.tick();
    await flush();
    expect(env.fetchCalls.filter((c) => c.url.startsWith("/events"))).toHaveLength(1);
    expect(env.fetchCalls.filter((c) => c.url.startsWith("/jobs/"))).toHaveLength(0);
  });

  it("(16) an events batch delivered mid-run surfaces a REMOTE job (never triggered on this page) in the feed", async () => {
    // job_started for an unknown id arrives via /events — the feed must pick it up without any
    // GET /jobs/:id ever being fetched for it (proving the feed-level migration, not a fallback poll).
    let eventsFired = false;
    const respond: VMOpts["respond"] = (url) => {
      if (url === "/health") return { status: 200, data: { ok: true } };
      if (url === "/projects") return { status: 200, data: { projects: [] } };
      if (url === "/jobs") return { status: 200, data: [{ id: "job-1", kind: "build", root: "/r", status: "running", createdAt: 1 }] };
      if (url.startsWith("/events")) {
        if (!eventsFired) {
          eventsFired = true;
          return { status: 200, data: { events: [{ type: "job_started", jobId: "remote-1", kind: "conduct", root: "/other" }], cursor: 1 } };
        }
        return { status: 200, data: { events: [], cursor: 1 } };
      }
      return { status: 404, data: {} };
    };
    const { env, api } = await boot({ token: TOKEN, respond });
    env.tick();
    await flush();
    expect(api.state.jobOrder).toContain("remote-1");
    expect(env.getEl("jobList").innerHTML).toContain("remote-1");
    expect(env.fetchCalls.some((c) => c.url === "/jobs/remote-1")).toBe(false);
  });

  it("(11) deep-link #job=<existing> restores the selection; a gone id degrades silently", async () => {
    const existing = await boot({ token: TOKEN, hash: "#job=job-b", respond: RUNNING_FEED });
    expect(existing.api.state.selectedJobId).toBe("job-b");
    // stage rendered for the selected job.
    expect(existing.env.getEl("stage").innerHTML.length).toBeGreaterThan(0);

    const gone = await boot({ token: TOKEN, hash: "#job=ghost-999", respond: RUNNING_FEED });
    expect(gone.api.state.selectedJobId).toBeUndefined(); // no selection, no throw
    expect(gone.env.getEl("jobList").innerHTML).toContain("job-a"); // feed still rendered
  });

  it("(12) hashchange switches selection; every selection path writes #job=<id>; mode persistence untouched", async () => {
    const { env, api } = await boot({ token: TOKEN, hash: "#job=job-b", mode: "full cycle", respond: RUNNING_FEED });
    expect(api.state.selectedJobId).toBe("job-b");
    const modeBefore = env.localData.get("sparra-bridge-mode");

    // Browser back/forward to another job id.
    env.location.hash = "#job=job-a";
    env.fireWindow("hashchange");
    expect(api.state.selectedJobId).toBe("job-a");

    // Feed-row selection path writes the hash.
    api.selectJob("job-c");
    expect(env.location.hash).toBe("#job=job-c");

    // Trigger auto-select path writes the hash too.
    api.view.recordJob({ phase: "build", root: "/r", jobId: "fresh-job" });
    expect(env.location.hash).toBe("#job=fresh-job");

    // Persisted operating mode is unchanged by any hash operation.
    expect(env.localData.get("sparra-bridge-mode")).toBe(modeBefore);
    expect(env.localData.get("sparra-bridge-mode")).toBe("full cycle");
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */
