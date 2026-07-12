/**
 * `conductors/http/handlers/dashboard.ts` — the `GET /` handler: the Sparra Bridge Console.
 *
 * Serves a SELF-CONTAINED HTML page by inlining `dashboard.client.js` (the DOM-free API/controller
 * layer `dashboard.test.ts` also drives directly) into `dashboard.html` (the mockup's CSS/markup +
 * the thin real `view` adapter + boot code) at the marker comment `CLIENT_SCRIPT_MARKER`, inside the
 * SAME `<script type="module">` — so the browser runs the identical code the tests exercise, with no
 * duplication and no second network round-trip for the client script.
 *
 * The assembled page is READ + BUILT ONCE and cached for the life of this route table (mirrors the
 * "read once" contract other bridge config/docs helpers already follow) — `readAsset` is injected so
 * a test can assert it's called exactly once across many `GET /` requests without touching real disk.
 *
 * `GET /` is served WITHOUT auth (like `GET /health`) — a browser's top-level navigation can't attach
 * an `Authorization` header, so the page itself must be reachable unauthenticated; every DATA call the
 * page's own client script makes is still Bearer-gated. When `bridge.yaml`'s `dashboard` is `false`,
 * the route 404s instead of ever reading/serving the asset.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { RouteDefinition, RouteResult } from "../server.ts";

/** The exact marker `dashboard.html` carries at its client-script injection point. Kept as a single
 *  named constant so the handler and the on-disk marker can never silently drift apart. */
export const CLIENT_SCRIPT_MARKER = "/* __SPARRA_DASHBOARD_CLIENT__ */";

const HERE = dirname(fileURLToPath(import.meta.url));
const ASSET_DIR = join(HERE, "..");

/** What one read of the on-disk assets yields: the page markup/CSS and the client script text. */
export interface DashboardAssets {
  html: string;
  client: string;
}

/** Real reader: both `conductors/http/dashboard.html` and `dashboard.client.js`, UTF-8, in ONE call. */
function defaultReadAssets(): DashboardAssets {
  return {
    html: readFileSync(join(ASSET_DIR, "dashboard.html"), "utf8"),
    client: readFileSync(join(ASSET_DIR, "dashboard.client.js"), "utf8"),
  };
}

/** Injected collaborators for the dashboard route. */
export interface DashboardRouteDeps {
  /** Reads BOTH on-disk assets in a single call. Defaults to a real `readFileSync` pair against this
   *  package's own directory. Injected so tests never touch real disk and can assert this is called
   *  exactly once — one spy, one call — across many `GET /` requests. */
  readAssets?: () => DashboardAssets;
}

/**
 * Build the served page ONCE per {@link createDashboardRoutes} call (i.e. once per server lifetime,
 * since `register.ts` calls this a single time at startup): read both assets via ONE `readAssets()`
 * call, inline the client script at the marker, and cache the result — every subsequent `GET /`
 * reuses the cached string without calling `readAssets` again.
 */
function buildAssembler(readAssets: () => DashboardAssets): () => string {
  let cached: string | undefined;
  return () => {
    if (cached === undefined) {
      const { html, client } = readAssets();
      if (!html.includes(CLIENT_SCRIPT_MARKER)) {
        throw new Error(
          `dashboard.html is missing its client-script injection marker (${CLIENT_SCRIPT_MARKER}) — refusing to serve a page that would drop the controller/API layer`,
        );
      }
      cached = html.replace(CLIENT_SCRIPT_MARKER, client);
    }
    return cached;
  };
}

/**
 * Build the dashboard route (`GET /`). Registered via `register.ts`'s normal seam like every other
 * route; the server's routing layer treats `GET /` as public (unauthenticated) the same way it
 * already does `GET /health` — see `server.ts`'s `handle()`.
 */
export function createDashboardRoutes(deps: DashboardRouteDeps = {}): RouteDefinition[] {
  const readAssets = deps.readAssets ?? defaultReadAssets;
  const assemble = buildAssembler(readAssets);

  return [
    {
      method: "GET",
      path: "/",
      handler: (ctx): RouteResult => {
        if (!ctx.config.dashboard) return { status: 404, body: { error: "not found" } };
        return { status: 200, html: assemble() };
      },
    },
  ];
}
