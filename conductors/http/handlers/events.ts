/**
 * `conductors/http/handlers/events.ts` — the `GET /events` cursor-delta endpoint.
 *
 * Read-only, lock-free (like `GET /projects`/`GET /jobs`), and Bearer-gated through the server's
 * normal route seam (no `public` flag here — see `server.ts`'s `compile`). Returns everything the
 * shared {@link EventLog} has retained since the caller's `since` cursor.
 */

import type { EventLog } from "../events.ts";
import type { RouteDefinition } from "../server.ts";

/** Injected collaborator: the ONE {@link EventLog} instance shared with the `JobStore` that emits
 *  into it (wired by `register.ts`/`startBridge` so both sides observe the same log). */
export interface EventsRouteDeps {
  eventLog: EventLog;
}

/**
 * Build the `GET /events` route. `since` is parsed off the request URL's query string (the server
 * strips the query before route matching, so we re-parse `ctx.req.url` ourselves) — a missing,
 * non-numeric, or negative value is treated as `0` (return everything retained).
 */
export function createEventsRoutes(deps: EventsRouteDeps): RouteDefinition[] {
  return [
    {
      method: "GET",
      path: "/events",
      handler: (ctx) => {
        const url = new URL(ctx.req.url ?? "", "http://bridge.invalid");
        const raw = url.searchParams.get("since");
        const parsed = raw !== null ? Number(raw) : NaN;
        const since = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
        return { status: 200, body: deps.eventLog.since(since) };
      },
    },
  ];
}
