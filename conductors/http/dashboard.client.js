/**
 * `conductors/http/dashboard.client.js` — the Sparra Bridge Console's client logic.
 *
 * Plain browser-compatible ESM. NOT TypeScript, NO Node built-ins (no `node:*` imports, no
 * `process`/`Buffer`) — this file runs UNCHANGED in a browser `<script type="module">` (inlined
 * verbatim by `handlers/dashboard.ts`) AND is `import`-able directly by a Node/vitest test with a
 * fake `fetch`. It is DOM-free: nothing here touches `document`/`window`/`sessionStorage` directly —
 * every side-effecting collaborator (`fetchImpl`, `storage`, `view`) is INJECTED, so every flow is
 * testable without a browser.
 *
 * Two layers:
 *   - **API** — `API_ENDPOINTS` (the allowlist), `buildRequest`/`apiCall` (the one choke-point every
 *     request must pass through), `projectSummary` (the holdout-safe projection for `/role` and
 *     `/unit` results).
 *   - **Controller** — one function per user-visible flow (`refreshHealth`, `refreshProjects`,
 *     `triggerPhase`, `triggerRole`, `triggerUnit`, `pollJob`, `cancelJob`, `showRoleResult`,
 *     `showUnitResult`, `setToken`, `clearToken`, `handleAuthError`, `handleLock`). Each takes an
 *     injected `{fetchImpl, storage, view}` and pushes results through `view` — never the DOM
 *     directly. `dashboard.html`'s real `view` adapter is the only place DOM writes happen.
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
 */
function matchEndpoint(method, path) {
  if (typeof path !== "string" || path.length === 0) return null;
  // Reject anything that isn't a bare same-origin relative path: an absolute URL (has a scheme), a
  // protocol-relative URL (`//host/...`), or a path carrying a query/fragment (which could hide a
  // segment that would otherwise fail the `:id` check below).
  if (!path.startsWith("/")) return null;
  if (path.startsWith("//")) return null;
  if (path.includes("?") || path.includes("#")) return null;

  const reqSegments = path.split("/").filter((s) => s.length > 0);
  for (const endpoint of API_ENDPOINTS) {
    if (endpoint.method !== method) continue;
    const tplSegments = endpoint.path.split("/").filter((s) => s.length > 0);
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

/** `GET /projects` → `view.renderProjects(projects)`. */
export async function refreshProjects(deps) {
  const result = await apiCall("GET", "/projects", { token: currentToken(deps), fetchImpl: deps.fetchImpl });
  dispatch(deps, result, (data) => deps.view.renderProjects((data && data.projects) || []));
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
 * mode. `commit`/`merge` are opt-in booleans, sent only when ON (omitted when off). Run-shaping fields
 * (`mode`/`maxUnits`/`concurrency`/`budget`/`maxTurns`) are fresh-run only — the caller omits them on a
 * resume (the server 400s them alongside `resume`). An unknown/extra `params` key is never forwarded.
 */
function buildConductBody(p) {
  return {
    root: p.root,
    ...(p.prompt ? { prompt: p.prompt } : {}),
    ...(p.resume ? { resume: p.resume } : {}),
    ...(p.auto !== undefined ? { auto: p.auto } : {}),
    ...(p.commit ? { commit: true } : {}),
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

/**
 * Read the trimmed value of the input matching `selector` SCOPED to the target card that owns
 * `el` (the clicked control) — walk up to the enclosing `.target` card via `closest`, then read
 * THAT card's own field. This is what makes the conduct prompt/resume affordances multi-target
 * safe: with several allowlisted targets rendered, a page-global `document.querySelector(selector)`
 * would always read the FIRST card's field, so clicking the second card's "resume run" button would
 * silently send the FIRST card's runId. Returns `""` when the card or field is absent.
 *
 * DOM-free by the same rule as the rest of this module: it touches ONLY the element passed in (via
 * `closest`/`querySelector`), never the global `document`/`window` — so a test can drive it with a
 * plain fake element and assert per-card resolution without a browser.
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

/** Poll `GET /jobs/:id` → `view.renderJob(job)` (status, the already-redacted phase log verbatim, and
 *  — for a conduct job — the holdout-safe projected `pendingDecisions`; no raw decision field crosses). */
export async function pollJob(deps, jobId) {
  const result = await apiCall("GET", `/jobs/${jobId}`, { token: currentToken(deps), fetchImpl: deps.fetchImpl });
  dispatch(deps, result, (data) => deps.view.renderJob(projectJobForView(data)));
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

// Deliberately NO `window.SparraDashboardClient = {...}` global here. `handlers/dashboard.ts` inlines
// this file's text into the SAME `<script type="module">` block as `dashboard.html`'s boot code (see
// the `CLIENT_SCRIPT_MARKER` injection point there), so the boot code calls `refreshHealth`,
// `triggerPhase`, etc. as plain local bindings in that shared module scope — never through a global.
