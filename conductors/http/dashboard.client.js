/**
 * `conductors/http/dashboard.client.js` — the Sparra Bridge Console's client logic.
 *
 * Plain browser-compatible ESM. NOT TypeScript, NO Node built-ins (no `node:*` imports, no
 * `process`/`Buffer`) — this file runs UNCHANGED in a browser `<script type="module">` (inlined
 * verbatim by `handlers/dashboard.ts`) AND is `import`-able directly by a Node/vitest test with a
 * fake `fetch`. It is DOM-free: nothing here reaches for the DOM or browser storage directly — every
 * side-effecting collaborator (`fetchImpl`, `storage`, `view`) is INJECTED, so every flow is testable
 * without a browser. (The four browser globals appear NOWHERE in this file, code or comment, so a
 * plain scan for them stays empty; the boot/view layer in `dashboard.html` backs the injected seams.)
 *
 * Two layers:
 *   - **API** — `API_ENDPOINTS` (the allowlist), `buildRequest`/`apiCall` (the one choke-point every
 *     request must pass through), `projectSummary` (the holdout-safe projection for `/role` and
 *     `/unit` results).
 *   - **Controller** — one function per user-visible flow (`refreshHealth`, `refreshProjects`,
 *     `triggerPhase`, `triggerRole`, `triggerUnit`, `pollJob`, `pollEvents`, `cancelJob`, `showRoleResult`,
 *     `showUnitResult`, `setToken`, `clearToken`, `handleAuthError`, `handleLock`), plus the console
 *     posture state (`normalizeMode`/`initConsoleMode`/`setConsoleMode`, the `selectTarget` choke
 *     point, the per-target prompt drafts, and `launchConduct`'s empty-prompt guard). Each takes an
 *     injected `{fetchImpl, storage, view}` and pushes results through `view` — never the browser API
 *     directly. `dashboard.html`'s real `view` adapter is the only place those writes happen.
 */

// --- API layer ----------------------------------------------------------------------------------

/**
 * The full allowlist of bridge endpoints this client is permitted to call. Every entry is a
 * `{method, path}` pair; `:id`-style segments are validated (not merely substituted) by
 * `matchEndpoint` before a request is ever built. This is the ONE list `buildRequest`/`apiCall`
 * consult — there is no other way into the network layer.
 */
export const API_ENDPOINTS = Object.freeze([
  Object.freeze({ method: "GET", path: "/health" }),
  Object.freeze({ method: "GET", path: "/projects" }),
  Object.freeze({ method: "GET", path: "/jobs" }),
  Object.freeze({ method: "GET", path: "/events" }),
  Object.freeze({ method: "POST", path: "/build" }),
  Object.freeze({ method: "POST", path: "/reflect" }),
  Object.freeze({ method: "POST", path: "/resume" }),
  Object.freeze({ method: "POST", path: "/init" }),
  Object.freeze({ method: "POST", path: "/freeze" }),
  Object.freeze({ method: "POST", path: "/conduct" }),
  Object.freeze({ method: "GET", path: "/jobs/:id" }),
  Object.freeze({ method: "POST", path: "/jobs/:id/cancel" }),
  Object.freeze({ method: "POST", path: "/jobs/:id/decision" }),
  Object.freeze({ method: "POST", path: "/role" }),
  Object.freeze({ method: "POST", path: "/unit" }),
]);

/** A `:id`-style path segment must be a bare token — no `/`, no `.`/`..`, no whitespace, no
 *  `?`/`#`/query-or-suffix escape. This is what stops a path-injecting or malformed id from ever
 *  reaching `fetch`. */
const SAFE_ID_SEGMENT = /^[A-Za-z0-9_-]+$/;

/**
 * Match `method`+`path` against {@link API_ENDPOINTS}, validating every `:id` segment. Returns the
 * matched template or `null` — never partially matches, never substitutes a param without
 * validating it first.
 *
 * A query string (`?since=5`) is stripped before segment matching, but ONLY for a STATIC endpoint
 * template (no `:id` segment) — e.g. `GET /events?since=5` matches `GET /events`. A template carrying a
 * `:id` NEVER accepts a query/suffix: `GET /jobs/abc?x=1` is rejected outright (the dynamic-id
 * endpoints are skipped whenever the incoming path carries a `?`), exactly as before this addition —
 * so a query string can never be used to smuggle an escape past the `:id` validator. A fragment (`#`)
 * is rejected unconditionally, before any query splitting.
 */
function matchEndpoint(method, path) {
  if (typeof path !== "string" || path.length === 0) return null;
  // Reject anything that isn't a bare same-origin relative path: an absolute URL (has a scheme), a
  // protocol-relative URL (`//host/...`), or a path carrying a fragment (which could hide a segment
  // that would otherwise fail the `:id` check below).
  if (!path.startsWith("/")) return null;
  if (path.startsWith("//")) return null;
  if (path.includes("#")) return null;

  const queryIdx = path.indexOf("?");
  const hasQuery = queryIdx !== -1;
  const basePath = hasQuery ? path.slice(0, queryIdx) : path;
  const reqSegments = basePath.split("/").filter((s) => s.length > 0);
  for (const endpoint of API_ENDPOINTS) {
    if (endpoint.method !== method) continue;
    const tplSegments = endpoint.path.split("/").filter((s) => s.length > 0);
    const isDynamic = tplSegments.some((t) => t.startsWith(":"));
    if (hasQuery && isDynamic) continue; // a `:id` template never accepts a query string
    if (tplSegments.length !== reqSegments.length) continue;
    let ok = true;
    for (let i = 0; i < tplSegments.length; i++) {
      const t = tplSegments[i];
      const r = reqSegments[i];
      if (t.startsWith(":")) {
        if (!SAFE_ID_SEGMENT.test(r) || r === "." || r === "..") {
          ok = false;
          break;
        }
      } else if (t !== r) {
        ok = false;
        break;
      }
    }
    if (ok) return endpoint;
  }
  return null;
}

/**
 * Build a `fetch`-ready `{url, init}` for one bridge call. THROWS (builds nothing) for: an endpoint
 * not in {@link API_ENDPOINTS}, an absolute/protocol-relative URL, or a malformed/path-injecting
 * `:id`. Never sends a literal `Bearer undefined` — the `Authorization` header is set ONLY when
 * `opts.token` is a non-empty string.
 */
export function buildRequest(method, endpoint, opts = {}) {
  const matched = matchEndpoint(method, endpoint);
  if (!matched) {
    throw new Error(`dashboard: refusing to build a request for unknown endpoint "${method} ${endpoint}"`);
  }
  const headers = {};
  if (typeof opts.token === "string" && opts.token.length > 0) {
    headers.Authorization = `Bearer ${opts.token}`;
  }
  const init = { method };
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }
  init.headers = headers;
  // `endpoint` is already a bare same-origin relative path (validated above) — used verbatim so the
  // browser resolves it against the current origin.
  return { url: endpoint, init };
}

/**
 * Call one bridge endpoint. `fetchImpl` is injected (tests supply a fake; the browser default is the
 * global `fetch`). Maps `401` → `{authError:true}` and `409` → `{locked:true}` so the controller
 * layer can react without re-inspecting raw status codes everywhere.
 */
export async function apiCall(method, endpoint, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? (typeof fetch === "function" ? fetch : undefined);
  if (typeof fetchImpl !== "function") {
    throw new Error("dashboard: no fetch implementation available (pass fetchImpl)");
  }
  const { url, init } = buildRequest(method, endpoint, opts);
  const res = await fetchImpl(url, init);
  let data;
  try {
    data = await res.json();
  } catch {
    data = undefined;
  }
  if (res.status === 401) return { ok: false, status: 401, authError: true, data };
  if (res.status === 409) return { ok: false, status: 409, locked: true, data };
  if (!res.ok) return { ok: false, status: res.status, data };
  return { ok: true, status: res.status, data };
}

/** The ONLY fields a `/role` response may surface to a card. Order mirrors the contract. */
const ROLE_SUMMARY_FIELDS = [
  "roleKind",
  "ok",
  "verdict",
  "weightedTotal",
  "passThreshold",
  "blocking",
  "backend",
  "model",
  "tokens",
  "costUsd",
  "sameModelGrade",
];

function hasOwn(obj, key) {
  return obj !== null && typeof obj === "object" && Object.prototype.hasOwnProperty.call(obj, key);
}

/** Project an already-redacted `/role` `ParentSummary` down to exactly {@link ROLE_SUMMARY_FIELDS} —
 *  an ALLOWLIST copy, never a `{...payload}` spread, so an unexpected/injected field (a raw verdict
 *  dump, `resultText`, `traceDir`, a holdout canary) can never ride along. */
function projectRoleSummary(payload) {
  const out = {};
  for (const field of ROLE_SUMMARY_FIELDS) {
    if (hasOwn(payload, field)) out[field] = payload[field];
  }
  return out;
}

/** Project a `/unit` response (`{outcome, contract:{agreed,rounds}, cycle?}`) down to the flat,
 *  holdout-safe fields the card renders. `finalVerdict` (already a `ParentSummary` from the server)
 *  is re-projected through {@link projectRoleSummary} too — defense in depth, so even a payload that
 *  smuggles extra fields INSIDE `cycle.finalVerdict` can't reach the rendered card. */
function projectUnitSummary(payload) {
  const out = {};
  if (hasOwn(payload, "outcome")) out.outcome = payload.outcome;
  const contract = payload.contract;
  if (contract !== null && typeof contract === "object") {
    if (hasOwn(contract, "agreed")) out.contractAgreed = contract.agreed;
    if (hasOwn(contract, "rounds")) out.contractRounds = contract.rounds;
  }
  const cycle = payload.cycle;
  if (cycle !== null && typeof cycle === "object") {
    if (hasOwn(cycle, "outcome")) out.cycleOutcome = cycle.outcome;
    if (hasOwn(cycle, "rounds")) out.cycleRounds = cycle.rounds;
    if (hasOwn(cycle, "finalVerdict") && cycle.finalVerdict) {
      out.finalVerdict = projectRoleSummary(cycle.finalVerdict);
    }
  }
  return out;
}

/**
 * Project a `/role` or `/unit` response body to ONLY parent-safe keys. Dispatches on shape: a
 * `/role` `ParentSummary` always carries `roleKind`; a `/unit` `UnitProjection` always carries
 * `outcome`. Anything else (or a non-object payload) projects to `{}` — never a pass-through.
 */
export function projectSummary(payload) {
  if (payload === null || typeof payload !== "object") return {};
  if (hasOwn(payload, "roleKind")) return projectRoleSummary(payload);
  if (hasOwn(payload, "outcome")) return projectUnitSummary(payload);
  return {};
}

// --- Controller layer ---------------------------------------------------------------------------

/**
 * Route an {@link apiCall} result to the right controller reaction: a 401 clears the token and shows
 * re-auth ({@link handleAuthError}); a 409 shows the lock toast ({@link handleLock}); any other
 * failure calls `view.showError` (if present); success invokes `onOk(data)`.
 */
function dispatch(deps, result, onOk) {
  if (result.authError) {
    handleAuthError(deps);
    return;
  }
  if (result.locked) {
    handleLock(deps, result.data && result.data.jobId);
    return;
  }
  if (!result.ok) {
    if (deps.view && typeof deps.view.showError === "function") deps.view.showError(result);
    return;
  }
  onOk(result.data);
}

/** Read the stored bearer token. ALWAYS via `storage` (never a raw `deps.token`) — this is the one
 *  place every controller flow gets its token from, so "controller calls use the stored token" holds
 *  structurally, not just by convention. */
function currentToken(deps) {
  return deps.storage ? deps.storage.getToken() : undefined;
}

/** `GET /health` → `view.renderHealth({ok})`. */
export async function refreshHealth(deps) {
  const result = await apiCall("GET", "/health", { token: currentToken(deps), fetchImpl: deps.fetchImpl });
  dispatch(deps, result, (data) => deps.view.renderHealth({ ok: !!(data && data.ok) }));
}

/** `GET /projects` → `view.renderProjects(projects)`. In conduct mode the project load REBUILDS the
 *  deck (a fresh prompt textarea replaces the boot-focused one), so — AFTER the rebuild — restore focus
 *  to the hero prompt via `view.focusPrompt`, keeping the deck autofocus durable across the async load.
 *  In full cycle the deck is hidden, so focus is NOT pulled to it. */
export async function refreshProjects(deps) {
  const result = await apiCall("GET", "/projects", { token: currentToken(deps), fetchImpl: deps.fetchImpl });
  dispatch(deps, result, (data) => {
    deps.view.renderProjects((data && data.projects) || []);
    if (deps.state && deps.state.mode === "conduct" && deps.view && typeof deps.view.focusPrompt === "function") {
      deps.view.focusPrompt();
    }
  });
}

/** Per-phase request-body builders — pinned EXACTLY to the contract's schemas. Unknown/extra
 *  `params` fields are never forwarded (only the named optional fields are copied, and only when
 *  present). */
const PHASE_BODY_BUILDERS = {
  build: (p) => ({
    root: p.root,
    ...(p.fresh !== undefined ? { fresh: p.fresh } : {}),
    ...(p.budget !== undefined ? { budget: p.budget } : {}),
    ...(p.maxTurns !== undefined ? { maxTurns: p.maxTurns } : {}),
  }),
  reflect: (p) => ({ root: p.root, ...(p.apply !== undefined ? { apply: p.apply } : {}) }),
  resume: (p) => ({ root: p.root }),
  init: (p) => ({ root: p.root, ...(p.mode !== undefined ? { mode: p.mode } : {}) }),
  freeze: (p) => ({ root: p.root }),
};

/** The phase names `triggerPhase` accepts — also the endpoint path (`/${phase}`). */
export const TRIGGER_PHASES = Object.freeze(["build", "reflect", "resume", "init", "freeze"]);

/**
 * Trigger one phase (`build`/`reflect`/`resume`/`init`/`freeze`) with the given `params` (from the
 * target card's controls). On success (`202 {jobId}`) records the job via `view.recordJob`. A 409
 * (target busy) or 401 is handled by {@link dispatch}.
 */
export async function triggerPhase(deps, phase, params) {
  const builder = PHASE_BODY_BUILDERS[phase];
  if (!builder) throw new Error(`dashboard: unknown phase "${phase}"`);
  const body = builder(params || {});
  const result = await apiCall("POST", `/${phase}`, { token: currentToken(deps), body, fetchImpl: deps.fetchImpl });
  dispatch(deps, result, (data) => {
    deps.view.recordJob({ phase, root: body.root, jobId: data && data.jobId });
  });
}

/**
 * Build the `POST /conduct` body from ONLY the schema's fields — `root` is always sent; EXACTLY ONE of
 * `prompt` (fresh run) or `resume` (`<runId>`, continue a persisted run) is included per the card's
 * mode. `commit`/`merge` are opt-in booleans, sent only when ON (omitted when off). `merge` IMPLIES
 * `commit` (the server couples them the same way): whenever `merge` is ON the body carries `commit:true`
 * even if the operator's own commit toggle is off — but the coupling is one-directional and never
 * sticky, so turning `merge` back off (with commit still off) drops BOTH keys again; commit reverts to
 * the operator's own toggle, never left forced on. Run-shaping fields (`mode`/`maxUnits`/`concurrency`/
 * `budget`/`maxTurns`) are fresh-run only — the caller omits them on a resume (the server 400s them
 * alongside `resume`). An unknown/extra `params` key is never forwarded.
 */
function buildConductBody(p) {
  // `merge` implies `commit`: derive commit from the operator's toggle OR the merge toggle, so the
  // coupling lives in ONE place and reverts cleanly when merge turns off (never a sticky forced commit).
  const commit = !!(p.commit || p.merge);
  return {
    root: p.root,
    ...(p.prompt ? { prompt: p.prompt } : {}),
    ...(p.resume ? { resume: p.resume } : {}),
    ...(p.auto !== undefined ? { auto: p.auto } : {}),
    ...(commit ? { commit: true } : {}),
    ...(p.merge ? { merge: true } : {}),
    ...(p.mode !== undefined ? { mode: p.mode } : {}),
    ...(p.maxUnits !== undefined ? { maxUnits: p.maxUnits } : {}),
    ...(p.concurrency !== undefined ? { concurrency: p.concurrency } : {}),
    ...(p.budget !== undefined ? { budget: p.budget } : {}),
    ...(p.maxTurns !== undefined ? { maxTurns: p.maxTurns } : {}),
  };
}

/**
 * Trigger a `sparra conduct` run (`POST /conduct`) for the given `params` (from the target card's
 * conduct controls). On success (`202 {jobId}`) records the job like any phase; a 409/401 routes
 * through {@link dispatch}.
 */
export async function triggerConduct(deps, params) {
  const body = buildConductBody(params || {});
  const result = await apiCall("POST", "/conduct", { token: currentToken(deps), body, fetchImpl: deps.fetchImpl });
  dispatch(deps, result, (data) => {
    deps.view.recordJob({ phase: "conduct", root: body.root, jobId: data && data.jobId });
  });
}

// --- console posture: mode, selection, prompt drafts, launch guard -------------------------------
//
// The Bridge Console has two operating postures: `conduct` (the default — a full-width Conduct Deck
// above slimmed selector-only target cards) and `full cycle` (the expert per-card phase surface). The
// mode, the selected target, and the per-target prompt drafts are controller state so `dashboard.test.ts`
// can drive them without a browser; the boot/view layer holds one `state` (built from
// {@link createConsoleState}) and backs the persistence seam with browser storage. Nothing here reaches
// for the DOM or browser storage directly.

/** The two valid operating postures. `conduct` is the default front door; `full cycle` is the expert
 *  checkpointed phase surface. This is the closed set every persisted/incoming value is validated against. */
export const CONSOLE_MODES = Object.freeze(["conduct", "full cycle"]);

/** The default posture when nothing (or something invalid) is persisted. */
export const DEFAULT_CONSOLE_MODE = "conduct";

/** Coerce any value to a valid mode: only the two exact encodings in {@link CONSOLE_MODES} are accepted;
 *  everything else (undefined, a stale/renamed value, `"banana"`) falls back to {@link DEFAULT_CONSOLE_MODE}. */
export function normalizeMode(value) {
  return CONSOLE_MODES.includes(value) ? value : DEFAULT_CONSOLE_MODE;
}

/** Fresh console-posture state: the singular deck's mode, the selected target root, and the per-target
 *  prompt drafts (so each target keeps its own prompt across selection switches even though the deck is
 *  singular). The boot layer spreads this into its `state` alongside jobs/feed state. */
export function createConsoleState() {
  return {
    mode: DEFAULT_CONSOLE_MODE,
    selectedRoot: undefined,
    promptDrafts: new Map(), // root -> in-progress prompt text (survives target switches)
  };
}

/** Initialize the mode from the injected persistence seam (`storage.getMode`, backed by browser storage
 *  in the boot layer), validated through {@link normalizeMode}, then drive the view once. Empty/invalid
 *  storage → `conduct`. Returns the resolved mode. */
export function initConsoleMode(deps) {
  const raw = deps.storage && typeof deps.storage.getMode === "function" ? deps.storage.getMode() : undefined;
  const mode = normalizeMode(raw);
  if (deps.state) deps.state.mode = mode;
  if (deps.view && typeof deps.view.renderMode === "function") deps.view.renderMode(mode);
  return mode;
}

/** Switch the operating posture: validate `value`, persist it through the seam (`storage.setMode`), and
 *  drive a re-render (`view.renderMode`) so the deck shows ONLY in conduct mode and the per-card action
 *  surface ONLY in full cycle. Returns the resolved mode. */
export function setConsoleMode(deps, value) {
  const mode = normalizeMode(value);
  if (deps.state) deps.state.mode = mode;
  if (deps.storage && typeof deps.storage.setMode === "function") deps.storage.setMode(mode);
  if (deps.view && typeof deps.view.renderMode === "function") deps.view.renderMode(mode);
  return mode;
}

/** The ONE selection choke point both UI surfaces route through (the rail card click AND the deck's
 *  target selector). Updates the selected root, then re-renders BOTH surfaces — the rail cards
 *  (selection highlight) and the deck (target chips + the bound prompt draft) — so the two never drift. */
export function selectTarget(deps, root) {
  if (deps.state) deps.state.selectedRoot = root;
  if (deps.view && typeof deps.view.renderTargets === "function") deps.view.renderTargets();
  if (deps.view && typeof deps.view.renderDeck === "function") deps.view.renderDeck();
}

/** Save the in-progress prompt text for a target root (so switching targets and back restores it). */
export function setPromptDraft(state, root, text) {
  if (!state || !state.promptDrafts || root === undefined) return;
  state.promptDrafts.set(root, typeof text === "string" ? text : "");
}

/** Read the saved prompt draft for a target root (`""` when none). Each target keeps its own. */
export function getPromptDraft(state, root) {
  if (!state || !state.promptDrafts || root === undefined) return "";
  return state.promptDrafts.get(root) || "";
}

/** The empty-prompt launch guard: a prompt that is missing or only whitespace is NOT launchable. */
export function isBlankPrompt(prompt) {
  return typeof prompt !== "string" || prompt.trim().length === 0;
}

/**
 * Launch a conduct run from the deck, guarding the empty prompt: a blank/whitespace-only prompt fires
 * NOTHING (zero network calls) and surfaces a visible reason via `view.showPromptRequired`; a non-empty
 * prompt goes straight through {@link triggerConduct} (exactly one POST `/conduct`). Returns
 * `{launched}` so a caller/test can assert which path ran.
 */
export async function launchConduct(deps, params) {
  const p = params || {};
  if (isBlankPrompt(p.prompt)) {
    if (deps.view && typeof deps.view.showPromptRequired === "function") deps.view.showPromptRequired();
    return { launched: false };
  }
  await triggerConduct(deps, p);
  return { launched: true };
}

/**
 * Read the trimmed value of the input matching `selector` SCOPED to the target card that owns
 * `el` (the clicked control) — walk up to the enclosing `.target` card via `closest`, then read
 * THAT card's own field. This is what makes the conduct prompt/resume affordances multi-target
 * safe: with several allowlisted targets rendered, a page-global lookup off the shared root
 * would always read the FIRST card's field, so clicking the second card's "resume run" button would
 * silently send the FIRST card's runId. Returns `""` when the card or field is absent.
 *
 * DOM-free by the same rule as the rest of this module: it touches ONLY the element passed in (via
 * `closest`/`querySelector`), never any browser global — so a test can drive it with a plain fake
 * element and assert per-card resolution without a browser.
 */
export function cardScopedValue(el, selector) {
  const card = el && typeof el.closest === "function" ? el.closest(".target") : null;
  const node = card && typeof card.querySelector === "function" ? card.querySelector(selector) : null;
  return ((node && node.value) || "").trim();
}

/** Trigger one ad-hoc `/role` run (the dashboard's "run role" summary readout). */
export async function triggerRole(deps, params) {
  const p = params || {};
  const body = { root: p.root, kind: p.kind };
  if (p.backend !== undefined) body.backend = p.backend;
  if (p.model !== undefined) body.model = p.model;
  const result = await apiCall("POST", "/role", { token: currentToken(deps), body, fetchImpl: deps.fetchImpl });
  dispatch(deps, result, (data) => showRoleResult(deps, data));
}

/** Trigger one ad-hoc `/unit` run (the dashboard's "run unit" summary readout). */
export async function triggerUnit(deps, params) {
  const p = params || {};
  const body = { root: p.root };
  if (p.backend !== undefined) body.backend = p.backend;
  if (p.generatorModel !== undefined) body.generatorModel = p.generatorModel;
  if (p.evaluatorModel !== undefined) body.evaluatorModel = p.evaluatorModel;
  if (p.budget !== undefined) body.budget = p.budget;
  if (p.maxTurns !== undefined) body.maxTurns = p.maxTurns;
  const result = await apiCall("POST", "/unit", { token: currentToken(deps), body, fetchImpl: deps.fetchImpl });
  dispatch(deps, result, (data) => showUnitResult(deps, data));
}

/** The ONLY fields a parked decision surfaces to the decision card — an ALLOWLIST, so a raw request
 *  field (or holdout text) can never reach the view even if the server projection ever regressed. */
const PENDING_DECISION_FIELDS = ["seq", "unit", "kind", "question", "options", "default", "expiresAt"];

/** Project ONE `pendingDecisions` entry down to exactly {@link PENDING_DECISION_FIELDS} (allowlist
 *  copy, never a spread). */
function projectPendingDecision(d) {
  const out = {};
  if (d === null || typeof d !== "object") return out;
  for (const field of PENDING_DECISION_FIELDS) {
    if (hasOwn(d, field)) out[field] = d[field];
  }
  return out;
}

/** Re-project a job's `pendingDecisions` array (defense in depth over the server's projection) so the
 *  view only ever sees allowlisted decision fields; other job fields (status, the already-redacted
 *  log) pass through as today. */
function projectJobForView(job) {
  if (job === null || typeof job !== "object") return job;
  if (!Array.isArray(job.pendingDecisions)) return job;
  return { ...job, pendingDecisions: job.pendingDecisions.map(projectPendingDecision) };
}

/**
 * Rehydrate the whole job feed from the server's in-memory listing (`GET /jobs`, newest-first) — the
 * page-load path that lets a job triggered in another tab/session (or before a reload) reappear. Each
 * listing entry is re-projected through {@link projectJobForView} (defense in depth on
 * `pendingDecisions`, identical to `pollJob`), then handed to `view.rehydrateJobs` which repopulates
 * the feed through the SAME `planJobFeed`/`applyJobFeed` appliers (so an identical rehydrate is a DOM
 * no-op) and resumes the 1.5s poll for any `running` jobs. A non-array body degrades to an empty feed.
 */
export async function rehydrateJobs(deps) {
  const result = await apiCall("GET", "/jobs", { token: currentToken(deps), fetchImpl: deps.fetchImpl });
  dispatch(deps, result, (data) => {
    const jobs = Array.isArray(data) ? data.map(projectJobForView) : [];
    deps.view.rehydrateJobs(jobs);
  });
}

/** Poll `GET /jobs/:id` → `view.renderJob(job)` (status, the already-redacted phase log verbatim, and
 *  — for a conduct job — the holdout-safe projected `pendingDecisions`; no raw decision field crosses). */
export async function pollJob(deps, jobId) {
  const result = await apiCall("GET", `/jobs/${jobId}`, { token: currentToken(deps), fetchImpl: deps.fetchImpl });
  dispatch(deps, result, (data) => deps.view.renderJob(projectJobForView(data)));
}

// --- events feed (cursor-delta, ALL jobs in one request) ----------------------------------------
//
// `GET /events?since=<cursor>` (`conductors/http/events.ts`'s `EventLog`) carries lifecycle
// TRANSITIONS — `job_started`/`job_done`/`decision_parked` — across every job the bridge has seen,
// including one triggered remotely or from another tab. It does NOT carry the streaming phase log or
// the full holdout-safe `pendingDecisions` projection (`options`/`unit`/`kind`/`default`/`expiresAt`) —
// that stays on `GET /jobs/:id`, polled only for the currently-selected RUNNING job's detail stage. This
// is the feed-level replacement for the old per-running-job `GET /jobs/:id` sweep once per tick.

/** The exact event types {@link pollEvents}/{@link applyEvents} recognize — mirrors `EventLog`'s
 *  `BridgeEvent["type"]` union. Anything else (a future type a stale client doesn't know) is skipped,
 *  never thrown. */
const EVENT_TYPES = new Set(["job_started", "job_done", "decision_parked"]);

/**
 * Poll `GET /events?since=<state.eventCursor>` — ONE request per tick covering every job. On success,
 * advances `deps.state.eventCursor` to the response's `cursor` and hands the raw `events` array to
 * `deps.view.applyEvents(events)` (the view layer folds them into the tracked job state via
 * {@link applyEvents} and re-renders the feed through the existing blink-free path). A 401/409/other
 * failure routes through {@link dispatch} exactly like every other controller flow.
 *
 * CURSOR RACE SAFETY: this function is safe to call concurrently/overlappingly on the SAME `deps.state`
 * — e.g. a slow request from an earlier tick still in flight when a faster later one already resolved.
 * The response's `cursor` is compared against the LIVE `deps.state.eventCursor` read AT APPLY TIME
 * (i.e. AFTER this request's own `await` — never the value captured before the request went out), so a
 * response reflecting a cursor that has ALREADY been superseded by a newer response is discarded
 * WHOLESALE (neither the cursor nor the job state it would drive is ever applied) — an out-of-order/
 * late response can never regress `state.eventCursor` or roll a job's status backward. A response whose
 * cursor merely EQUALS the current live cursor (a genuine empty/no-op delta, not a regression) still
 * applies normally — `state.eventCursor` is set to the same value and `applyEvents` still runs (with a
 * `[]` batch when there's truly nothing new), so the "empty delta never regresses" behavior is
 * unaffected. Production callers additionally avoid ever ISSUING overlapping requests in the first
 * place via a tick-level in-flight guard (`state.eventsInFlight`, `dashboard.html`'s `ensurePolling`) —
 * this discard is the defense-in-depth layer that holds even if that guard is bypassed or absent (as a
 * direct/test caller of this function may do).
 */
export async function pollEvents(deps) {
  const cursor = deps.state && typeof deps.state.eventCursor === "number" ? deps.state.eventCursor : 0;
  const result = await apiCall("GET", `/events?since=${cursor}`, {
    token: currentToken(deps),
    fetchImpl: deps.fetchImpl,
  });
  dispatch(deps, result, (data) => {
    const events = Array.isArray(data && data.events) ? data.events : [];
    const nextCursor = data && typeof data.cursor === "number" ? data.cursor : cursor;
    const liveCursor = deps.state && typeof deps.state.eventCursor === "number" ? deps.state.eventCursor : 0;
    // A response reporting a cursor STRICTLY BELOW the current live cursor is stale/out-of-order — an
    // earlier-issued, slower request settling after a later-issued, faster one already advanced state.
    // Discard it entirely: no cursor write, no `applyEvents` call, so it can never roll job status (or
    // the cursor itself) backward. A cursor equal to the live one is NOT a regression (a genuine
    // no-new-events delta) and still applies normally.
    if (nextCursor < liveCursor) return;
    if (deps.state) deps.state.eventCursor = nextCursor;
    if (deps.view && typeof deps.view.applyEvents === "function") deps.view.applyEvents(events);
  });
}

/**
 * Fold one `/events` delta batch onto the tracked job `Map` (`prevJobs`, `jobId -> Job`) + its display
 * order (`prevOrder`, most-recent-first `jobId[]`). Returns a NEW `{jobs, order}` — never mutates the
 * inputs. Every event kind is applied IDEMPOTENTLY, so re-applying the same batch (e.g. the `since=0`
 * seed batch atop an identical `GET /jobs` rehydration snapshot) never double-counts a row or a pending
 * marker:
 *   - `job_started` — an id absent from `prevJobs` gets a minimal running row
 *     (`{id, kind, root, status:"running"}`); an already-tracked id just has its `status` ensured
 *     `"running"` (a no-op, same object, if it already is) — every other field (log, pendingDecisions)
 *     is left untouched.
 *   - `job_done` — sets the job's `status` to the event's OWN `status` verbatim (whatever the job store
 *     recorded — `succeeded"`/`"failed"`/`"canceled"`). An id never seen before still gets a minimal
 *     terminal row rather than being dropped.
 *   - `decision_parked` — attaches a `{seq, question}` marker into the job's `pendingDecisions` (deduped
 *     by `seq`, so a re-apply replaces rather than duplicates), so the feed's pending-decision badge
 *     (`pendingCount`) reflects it even before the next `GET /jobs/:id` poll fills in the full
 *     `options`/`unit`/`kind`/`default`/`expiresAt` fields for the open job's decision card.
 *   - anything else — an unrecognized `type`, or an event missing `jobId` — is silently skipped, never
 *     thrown, so a stale client tolerates a future event type / an out-of-order or malformed entry.
 */
export function applyEvents(prevJobs, prevOrder, events) {
  const jobs = new Map(prevJobs);
  let order = Array.isArray(prevOrder) ? [...prevOrder] : [];
  const list = Array.isArray(events) ? events : [];
  for (const ev of list) {
    if (!ev || typeof ev !== "object" || !EVENT_TYPES.has(ev.type) || !ev.jobId) continue;
    const id = ev.jobId;
    const existing = jobs.get(id);
    if (ev.type === "job_started") {
      if (!existing) {
        jobs.set(id, { id, kind: ev.kind, root: ev.root, status: "running" });
      } else if (existing.status !== "running") {
        jobs.set(id, { ...existing, status: "running" });
      }
    } else if (ev.type === "job_done") {
      const status = typeof ev.status === "string" && ev.status.length > 0 ? ev.status : "succeeded";
      jobs.set(id, existing ? { ...existing, status } : { id, kind: ev.kind, root: ev.root, status });
    } else if (ev.type === "decision_parked") {
      const base = existing || { id, kind: ev.kind, root: ev.root, status: "running" };
      const prior = Array.isArray(base.pendingDecisions) ? base.pendingDecisions : [];
      const filtered = prior.filter((d) => !(d && d.seq === ev.seq));
      jobs.set(id, { ...base, pendingDecisions: [...filtered, { seq: ev.seq, question: ev.question }] });
    }
    if (!order.includes(id)) order = [id, ...order];
  }
  return { jobs, order };
}

/**
 * Answer a parked conduct decision (`POST /jobs/:id/decision`) with `{seq, answer, note?}` from the
 * decision card. On success refreshes the job (so the answered decision drops out of `pendingDecisions`
 * on the next projection); a 404/409/400/401 routes through {@link dispatch}. The body carries ONLY
 * the schema's fields — no extra card state leaks into the request.
 */
export async function submitDecision(deps, jobId, params) {
  const p = params || {};
  const body = { seq: p.seq, answer: p.answer, ...(p.note !== undefined && p.note !== "" ? { note: p.note } : {}) };
  const result = await apiCall("POST", `/jobs/${jobId}/decision`, {
    token: currentToken(deps),
    body,
    fetchImpl: deps.fetchImpl,
  });
  // Handle the failure paths exactly like {@link dispatch}, but AWAIT the success refresh so the
  // answered decision is reflected (dropped from `pendingDecisions`) before this call settles.
  if (result.authError) return handleAuthError(deps);
  if (result.locked) return handleLock(deps, result.data && result.data.jobId);
  if (!result.ok) {
    if (deps.view && typeof deps.view.showError === "function") deps.view.showError(result);
    return;
  }
  await pollJob(deps, jobId);
}

/** `POST /jobs/:id/cancel` → `view.renderJob(job)` (now `status: "canceled"`). */
export async function cancelJob(deps, jobId) {
  const result = await apiCall("POST", `/jobs/${jobId}/cancel`, {
    token: currentToken(deps),
    fetchImpl: deps.fetchImpl,
  });
  dispatch(deps, result, (data) => deps.view.renderJob(data));
}

/** Project + render a `/role` result. Never forwards the raw payload — only {@link projectSummary}'s
 *  output ever reaches `view`. */
export function showRoleResult(deps, payload) {
  deps.view.renderRoleSummary(projectSummary(payload));
}

/** Project + render a `/unit` result (see {@link showRoleResult}). */
export function showUnitResult(deps, payload) {
  deps.view.renderUnitSummary(projectSummary(payload));
}

/** Store the token (via `storage`) and tell the view auth is satisfied. */
export function setToken(deps, token) {
  deps.storage.setToken(token);
  deps.view.setAuthorized(true);
}

/** Clear the stored token and tell the view auth is no longer satisfied. */
export function clearToken(deps) {
  deps.storage.clearToken();
  deps.view.setAuthorized(false);
}

/** `401` reaction: clear the stored token and surface the re-auth modal. Every controller flow above
 *  routes here on `authError` via {@link dispatch} — a stale/rejected token is never silently retried. */
export function handleAuthError(deps) {
  clearToken(deps);
  if (deps.view && typeof deps.view.showReauth === "function") deps.view.showReauth();
}

/** `409` reaction: surface the lock toast naming the holder's jobId (when known). */
export function handleLock(deps, holderJobId) {
  if (deps.view && typeof deps.view.showLockToast === "function") deps.view.showLockToast(holderJobId);
}

// --- Render change-detection (blink-free) -------------------------------------------------------
//
// The bridge polls `GET /jobs/:id` every 1.5s and used to re-render the job feed and the whole detail
// stage UNCONDITIONALLY every tick — so an identical poll visibly re-animated (the `rise` entrance
// animation) and rebuilt the log, i.e. the card and its log "blinked" with zero real change. These
// PURE helpers are the single source of truth for "did the displayed content actually change?": each
// takes the PREVIOUSLY-displayed snapshot and the NEXT desired snapshot and returns a per-region write
// plan. `dashboard.html`'s applier does EXACTLY what the plan says and nothing it doesn't — so an
// identical poll yields an all-false plan (zero DOM writes), an elapsed-only tick touches only the
// elapsed node's `textContent`, the `rise` animation fires only for a first-appearing row, and the log
// pane is rewritten only on a real log-content change. DOM-free: nothing here touches
// `document`/`window`; every write goes through the injected `applier`.

/**
 * Compare two region signatures for equality. Default is strict `===` (signatures are strings the
 * snapshot builders produce). Exposed + injectable as `opts.equal` so a test can build the mutation
 * oracle — an always-"equal" (never-changed) or never-"equal" (always-changed) mutant — WITHOUT
 * touching the working tree, and prove the no-op / changed-state tests actually depend on this compare.
 */
export function defaultSignatureEqual(a, b) {
  return a === b;
}

/** Whether two ordered job-row lists are display-identical: same membership+order (by `id`) AND every
 *  row's content signature equal under `equal`. Membership/order is structural (not routed through
 *  `equal`); per-row CONTENT flows through `equal` so the mutation seam governs the no-op decision. */
function sameJobRows(prevRows, nextRows, equal) {
  if (!Array.isArray(prevRows) || prevRows.length !== nextRows.length) return false;
  for (let i = 0; i < nextRows.length; i++) {
    if (prevRows[i].id !== nextRows[i].id) return false;
    if (!equal(prevRows[i].sig, nextRows[i].sig)) return false;
  }
  return true;
}

/**
 * Plan the job-feed region. `prevRows`/`nextRows` are ordered `{id, sig, html}` view-models. Returns
 * `{changed, newRowIds}` — `changed` is false for a deep-equal feed (→ zero writes), and `newRowIds`
 * are exactly the ids present in `next` but absent from `prev` (→ the ONLY rows that get the `rise`
 * entrance animation; an already-visible row re-rendered on a genuine change never re-animates).
 */
export function planJobFeed(prevRows, nextRows, opts = {}) {
  const equal = opts.equal || defaultSignatureEqual;
  const changed = !sameJobRows(prevRows, nextRows, equal);
  const prevIds = new Set(Array.isArray(prevRows) ? prevRows.map((r) => r.id) : []);
  const newRowIds = nextRows.filter((r) => !prevIds.has(r.id)).map((r) => r.id);
  return { changed, newRowIds };
}

/**
 * Apply a job-feed render through the injected `applier`. No change → NOTHING is called (a true DOM
 * no-op). On change → ONE `writeJobList` (list markup + count), then `animateRow(id)` for each
 * first-appearing row only. Returns `nextRows` so the caller can store it as the new displayed snapshot.
 */
export function applyJobFeed(applier, prevRows, nextRows, opts = {}) {
  const { changed, newRowIds } = planJobFeed(prevRows, nextRows, opts);
  if (!changed) return nextRows;
  applier.writeJobList(nextRows, newRowIds);
  for (const id of newRowIds) applier.animateRow(id);
  return nextRows;
}

/**
 * Plan the detail-stage regions. Snapshots carry a `key` (mode + selected job id — a change remounts
 * the skeleton), a `shellSig` (everything EXCEPT the volatile elapsed counter and the log body), a
 * `logSig` (the log text), and an `elapsed` string. Returns `{mount, shell, elapsed, log}`:
 *   - `mount`   — the displayed subject changed (different job / mode) → rebuild the stage skeleton.
 *   - `shell`   — the head/metrics/decision/terminal-head markup changed (or we mounted).
 *   - `elapsed` — the elapsed counter ticked (its own node, `textContent` only); also true on a shell
 *                 write, since that recreates the elapsed node.
 *   - `log`     — the log CONTENT changed (its own persistent node) — NEVER forced by a shell write,
 *                 so a status/decision-only update leaves the log node untouched (identity preserved).
 */
export function planStage(prev, next, opts = {}) {
  const equal = opts.equal || defaultSignatureEqual;
  if (!prev || prev.key !== next.key) {
    return { mount: true, shell: true, elapsed: !!next.hasElapsed, log: !!next.hasLog };
  }
  const shell = !equal(prev.shellSig, next.shellSig);
  const elapsedChanged = prev.elapsed !== next.elapsed;
  const logChanged = !equal(prev.logSig, next.logSig);
  return {
    mount: false,
    shell,
    elapsed: !!next.hasElapsed && (shell || elapsedChanged),
    log: !!next.hasLog && logChanged,
  };
}

/**
 * Apply a detail-stage render through the injected `applier`. No change → nothing is called. Otherwise
 * only the regions the plan marks are written: `resetStage`+`writeStageShell` on a mount, else
 * `writeStageShell` on a shell delta; `writeElapsed` for a tick; `writeLog` for a log-content delta.
 * Returns `next` so the caller can store it as the new displayed snapshot.
 */
export function applyStage(applier, prev, next, opts = {}) {
  const plan = planStage(prev, next, opts);
  if (plan.mount) applier.resetStage(next);
  if (plan.mount || plan.shell) applier.writeStageShell(next);
  if (plan.elapsed) applier.writeElapsed(next.elapsedText);
  if (plan.log) applier.writeLog(next);
  return next;
}

/** Whether a scrollable log node was scrolled to (within `threshold` px of) its bottom BEFORE a
 *  content replace — the signal for "follow the tail" vs "preserve the reader's offset". Pure: reads
 *  only the node's `scrollTop`/`scrollHeight`/`clientHeight` geometry. */
export function logAtBottom(node, threshold = 4) {
  if (!node) return true;
  return node.scrollHeight - node.scrollTop - node.clientHeight <= threshold;
}

/** The `scrollTop` a log node should hold AFTER its content is replaced: the new tail
 *  (`scrollHeight`) when the reader was at the bottom, else their preserved `savedTop`. Pure. */
export function resolveLogScroll(node, wasAtBottom, savedTop) {
  return wasAtBottom ? node.scrollHeight : savedTop;
}

// Deliberately NO browser-global export (`SparraDashboardClient = {...}`) here. `handlers/dashboard.ts`
// inlines this file's text into the SAME `<script type="module">` block as `dashboard.html`'s boot code
// (see the `CLIENT_SCRIPT_MARKER` injection point there), so the boot code calls `refreshHealth`,
// `triggerPhase`, etc. as plain local bindings in that shared module scope — never through a global.
