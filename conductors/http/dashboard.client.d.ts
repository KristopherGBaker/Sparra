/** Ambient types for `dashboard.client.js` (plain JS, no Node built-ins) so `dashboard.test.ts` can
 *  import it with type-checking. Kept intentionally loose — the JS file is the source of truth. */
export interface ApiEndpoint {
  method: string;
  path: string;
}
export const API_ENDPOINTS: readonly ApiEndpoint[];
export const TRIGGER_PHASES: readonly string[];

export interface BuildRequestOpts {
  token?: string;
  body?: unknown;
}
export function buildRequest(
  method: string,
  endpoint: string,
  opts?: BuildRequestOpts,
): { url: string; init: { method: string; headers: Record<string, string>; body?: string } };

export interface ApiCallOpts extends BuildRequestOpts {
  fetchImpl?: (url: string, init: unknown) => Promise<{ status: number; ok: boolean; json: () => Promise<unknown> }>;
}
export interface ApiCallResult {
  ok: boolean;
  status: number;
  data?: unknown;
  authError?: boolean;
  locked?: boolean;
}
export function apiCall(method: string, endpoint: string, opts?: ApiCallOpts): Promise<ApiCallResult>;
export function projectSummary(payload: unknown): Record<string, unknown>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ControllerDeps = any;

export function refreshHealth(deps: ControllerDeps): Promise<void>;
export function refreshProjects(deps: ControllerDeps): Promise<void>;
export function triggerPhase(deps: ControllerDeps, phase: string, params: Record<string, unknown>): Promise<void>;
export function triggerRole(deps: ControllerDeps, params: Record<string, unknown>): Promise<void>;
export function triggerUnit(deps: ControllerDeps, params: Record<string, unknown>): Promise<void>;
export function pollJob(deps: ControllerDeps, jobId: string): Promise<void>;
export function cancelJob(deps: ControllerDeps, jobId: string): Promise<void>;
export function showRoleResult(deps: ControllerDeps, payload: unknown): void;
export function showUnitResult(deps: ControllerDeps, payload: unknown): void;
export function setToken(deps: ControllerDeps, token: string): void;
export function clearToken(deps: ControllerDeps): void;
export function handleAuthError(deps: ControllerDeps): void;
export function handleLock(deps: ControllerDeps, holderJobId?: string): void;
