/** Ambient types for `dashboard.client.js` (plain JS, no Node built-ins) so `dashboard.test.ts` can
 *  import it with type-checking. Kept intentionally loose — the JS file is the source of truth. */
export interface ApiEndpoint {
  method: string;
  path: string;
}
export const API_ENDPOINTS: readonly ApiEndpoint[];
export const TRIGGER_PHASES: readonly string[];

/** The two valid console operating postures (closed set). */
export const CONSOLE_MODES: readonly string[];
export const DEFAULT_CONSOLE_MODE: string;

/** Console-posture state the boot/view layer spreads into its `state` and tests construct directly. */
export interface ConsoleState {
  mode: string;
  selectedRoot: string | undefined;
  promptDrafts: Map<string, string>;
  [key: string]: unknown;
}
export function createConsoleState(): ConsoleState;
export function normalizeMode(value: unknown): string;
export function initConsoleMode(deps: ControllerDeps): string;
export function setConsoleMode(deps: ControllerDeps, value: unknown): string;
export function selectTarget(deps: ControllerDeps, root: string): void;
export function setPromptDraft(state: ConsoleState, root: string, text: string): void;
export function getPromptDraft(state: ConsoleState, root: string): string;
export function isBlankPrompt(prompt: unknown): boolean;
export function launchConduct(deps: ControllerDeps, params: Record<string, unknown>): Promise<{ launched: boolean }>;

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

/** A minimal element shape `cardScopedValue` walks — the browser's real `Element` satisfies it, and a
 *  test can pass a plain fake with just `closest`. Loose on purpose (the JS file is the source of truth). */
export interface CardScopedElement {
  closest?: (selector: string) => { querySelector?: (selector: string) => { value?: string } | null } | null;
}
export function cardScopedValue(el: CardScopedElement | null | undefined, selector: string): string;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ControllerDeps = any;

export function refreshHealth(deps: ControllerDeps): Promise<void>;
export function refreshProjects(deps: ControllerDeps): Promise<void>;
export function triggerPhase(deps: ControllerDeps, phase: string, params: Record<string, unknown>): Promise<void>;
export function triggerConduct(deps: ControllerDeps, params: Record<string, unknown>): Promise<void>;
export function triggerRole(deps: ControllerDeps, params: Record<string, unknown>): Promise<void>;
export function triggerUnit(deps: ControllerDeps, params: Record<string, unknown>): Promise<void>;
export function pollJob(deps: ControllerDeps, jobId: string): Promise<void>;
export function rehydrateJobs(deps: ControllerDeps): Promise<void>;
export function submitDecision(deps: ControllerDeps, jobId: string, params: Record<string, unknown>): Promise<void>;
export function cancelJob(deps: ControllerDeps, jobId: string): Promise<void>;
export function showRoleResult(deps: ControllerDeps, payload: unknown): void;
export function showUnitResult(deps: ControllerDeps, payload: unknown): void;
export function setToken(deps: ControllerDeps, token: string): void;
export function clearToken(deps: ControllerDeps): void;
export function handleAuthError(deps: ControllerDeps): void;
export function handleLock(deps: ControllerDeps, holderJobId?: string): void;

// --- render change-detection (blink-free) -------------------------------------------------------

/** Injectable region-signature comparator (default strict `===`); the mutation-oracle seam. */
export function defaultSignatureEqual(a: unknown, b: unknown): boolean;

/** An ordered job-feed row view-model: stable `id`, content `sig`, and rendered `html`. */
export interface JobRowView {
  id: string;
  sig: string;
  html: string;
}

/** Opts shared by the plan/apply helpers — swap `equal` to build the mutation oracle. */
export interface RenderPlanOpts {
  equal?: (a: unknown, b: unknown) => boolean;
}

export function planJobFeed(
  prevRows: JobRowView[] | undefined,
  nextRows: JobRowView[],
  opts?: RenderPlanOpts,
): { changed: boolean; newRowIds: string[] };

/** The applier the page (or a test's spy) supplies — every DOM write goes through it. */
export interface JobFeedApplier {
  writeJobList: (rows: JobRowView[], newRowIds: string[]) => void;
  animateRow: (id: string) => void;
}

export function applyJobFeed(
  applier: JobFeedApplier,
  prevRows: JobRowView[] | undefined,
  nextRows: JobRowView[],
  opts?: RenderPlanOpts,
): JobRowView[];

/** A displayed-stage snapshot: `key` (mode + subject), region signatures, and the volatile counter. */
export interface StageSnapshot {
  key: string;
  hasElapsed?: boolean;
  hasLog?: boolean;
  shellSig: string;
  logSig?: string;
  elapsed?: string;
  elapsedText?: string;
  [extra: string]: unknown;
}

export function planStage(
  prev: StageSnapshot | undefined,
  next: StageSnapshot,
  opts?: RenderPlanOpts,
): { mount: boolean; shell: boolean; elapsed: boolean; log: boolean };

export interface StageApplier {
  resetStage: (next: StageSnapshot) => void;
  writeStageShell: (next: StageSnapshot) => void;
  writeElapsed: (text: string | undefined) => void;
  writeLog: (next: StageSnapshot) => void;
}

export function applyStage(
  applier: StageApplier,
  prev: StageSnapshot | undefined,
  next: StageSnapshot,
  opts?: RenderPlanOpts,
): StageSnapshot;

export interface LogScrollNode {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}
export function logAtBottom(node: LogScrollNode | null | undefined, threshold?: number): boolean;
export function resolveLogScroll(node: LogScrollNode, wasAtBottom: boolean, savedTop: number): number;
