import type { LimitHit } from "../sdk/backend.ts";
import type { SparraConfig } from "../config.ts";
import { sleep } from "../util/sleep.ts";

export type AutoRestartConfig = SparraConfig["build"]["autoRestart"];

/**
 * The "heartbeat": when the build loop hits a provider rate/usage limit, wait for the
 * window to reopen instead of burning a round on a dead session.
 *
 * A single wait is bounded by `maxWaitSec`. When the backend reports a reset time
 * (Claude plan limits do), we sleep until then (+ a small cushion), capped by maxWaitSec.
 * When it doesn't (Codex), we sleep one `pollSec` interval and let the caller retry — a
 * still-limited retry produces another LimitHit and another wait. The caller bounds the
 * total number of these cycles via `maxRestarts`, so a stuck limit can't loop forever.
 */

/** How long a single wait should sleep, in ms. Pure (clock injected) so it's unit-testable. */
export function waitMsFor(hit: LimitHit, cfg: AutoRestartConfig, nowMs: number): number {
  const capMs = Math.max(0, cfg.maxWaitSec * 1000);
  if (hit.resetAt && hit.resetAt > nowMs) {
    return Math.min(hit.resetAt - nowMs + 5_000, capMs); // +5s cushion past the reset
  }
  return Math.min(Math.max(0, cfg.pollSec * 1000), capMs); // no reset time → one poll interval
}

/** Sleep out one limit-wait cycle, narrating progress. Injected as a BuildDeps seam so
 *  tests substitute an instant no-op (no real time passes). */
export async function waitForLimit(
  hit: LimitHit,
  cfg: AutoRestartConfig,
  log: (m: string) => void,
  signal?: AbortSignal,
  nowMs: number = Date.now()
): Promise<void> {
  const ms = waitMsFor(hit, cfg, nowMs);
  const resumes = hit.resetAt
    ? `~${new Date(hit.resetAt).toLocaleTimeString()}`
    : `recheck in ${Math.ceil(ms / 1000)}s`;
  log(
    `${hit.kind} limit hit${hit.rateLimitType ? ` (${hit.rateLimitType})` : ""} — pausing ${Math.ceil(ms / 1000)}s, resumes ${resumes}.`
  );
  await sleep(ms, signal);
}
