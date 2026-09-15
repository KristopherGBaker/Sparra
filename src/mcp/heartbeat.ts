/**
 * Keep-alive progress for a LONG `run_role` tool call.
 *
 * An MCP client aborts a tool call that goes quiet: three field deaths in two days were
 * "sent no response or progress for 1800s", and they were not random — they were the VERIFY-HEAVY
 * runs. A unit with two `xcodebuild` gates plus a determinism rerun spends half an hour inside a
 * single Bash call with nothing crossing the MCP boundary, so the idle guard reliably kills exactly
 * the runs that cost the most, after they have done the most work.
 *
 * The protocol already has the answer: `notifications/progress`. This emits one on a timer for the
 * life of the call, which resets the client's idle guard while the role is alive. It is a
 * LIVENESS signal about the tool call, not about the model — a genuinely wedged session keeps
 * heart-beating, so the elapsed figure is in every message and a conductor watching the numbers
 * climb with no result is the one who decides to cancel.
 *
 * Only fires when the client actually asked for progress (it supplied a `progressToken`); without
 * one there is nothing to attach a notification to.
 */

/** The notification sender shape `RequestHandlerExtra.sendNotification` satisfies. */
export type NotificationSender = (n: {
  method: "notifications/progress";
  params: { progressToken: string | number; progress: number; total?: number; message?: string };
}) => Promise<void>;

export interface HeartbeatArgs {
  /** Absent → no-op (the client did not request progress). */
  progressToken?: string | number;
  sendNotification: NotificationSender;
  /** What is running, e.g. `run_role generator`. */
  label: string;
  /** Extra context appended to each message (e.g. the trace dir to tail). */
  detail?: string;
  intervalMs?: number;
  /** Injected for tests. */
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  nowMs?: () => number;
}

/**
 * Default beat. Comfortably inside a client idle guard measured in minutes (the observed one was
 * 1800s) while staying cheap — a handful of notifications across a half-hour native build.
 */
export const HEARTBEAT_INTERVAL_MS = 60_000;

/** Pure: the message body for one beat. Names elapsed time so a stuck run is visible AS stuck. */
export function heartbeatMessage(label: string, elapsedMs: number, detail?: string): string {
  const mins = Math.floor(elapsedMs / 60_000);
  const secs = Math.floor((elapsedMs % 60_000) / 1000);
  const elapsed = mins > 0 ? `${mins}m${String(secs).padStart(2, "0")}s` : `${secs}s`;
  return `${label}: still running (${elapsed} elapsed)${detail ? ` — ${detail}` : ""}`;
}

/**
 * Start beating. Returns a `stop()` the caller MUST invoke in a `finally` — an interval outliving
 * its tool call would keep a stdio server's event loop alive after the work finished.
 * A send failure is swallowed: a dropped keep-alive must never fail the role-run it is protecting.
 */
export function startHeartbeat(args: HeartbeatArgs): () => void {
  if (args.progressToken === undefined) return () => {};
  const setI = args.setIntervalFn ?? setInterval;
  const clearI = args.clearIntervalFn ?? clearInterval;
  const now = args.nowMs ?? Date.now;
  const startedAt = now();
  let beats = 0;
  const timer = setI(() => {
    beats += 1;
    void args
      .sendNotification({
        method: "notifications/progress",
        params: {
          progressToken: args.progressToken!,
          progress: beats, // monotonic; no `total` — the duration is genuinely unknown
          message: heartbeatMessage(args.label, now() - startedAt, args.detail),
        },
      })
      .catch(() => {
        // best-effort keep-alive
      });
  }, args.intervalMs ?? HEARTBEAT_INTERVAL_MS);
  // Don't hold the process open for a beat that is only a keep-alive.
  (timer as { unref?: () => void }).unref?.();
  return () => clearI(timer);
}
