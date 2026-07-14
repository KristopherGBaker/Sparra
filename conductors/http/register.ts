/**
 * `conductors/http/register.ts` — wire every trigger + conductor + dashboard handler into U1's route
 * registry.
 *
 * `registerBridgeRoutes` builds the phase routes and the conductor routes over a SINGLE shared
 * {@link TargetLock}, so a phase writer and a conductor writer contend on the SAME per-target lock
 * (a `/build` in flight blocks a `/unit` on that root, and vice versa), and adds the dashboard's
 * `GET /` alongside them. U1's `startBridge` calls this so the running server exposes the full
 * surface, without ever editing `server.ts`'s core routing/auth logic for any OTHER route.
 */

import { createConductRoutes, type ConductRouteDeps } from "./handlers/conduct.ts";
import { createConductorRoutes, type ConductorRouteDeps } from "./handlers/conductor.ts";
import { createDashboardRoutes, type DashboardRouteDeps } from "./handlers/dashboard.ts";
import { createEventsRoutes } from "./handlers/events.ts";
import { createPhaseRoutes, type PhaseRouteDeps } from "./handlers/phases.ts";
import { EventLog } from "./events.ts";
import type { RouteDefinition } from "./server.ts";
import { TargetLock } from "./spawn.ts";

/** Injectable deps for the whole bridge surface — every seam a test needs to avoid a real
 *  spawn/model/network call. */
export interface BridgeRouteDeps {
  /** Shared mutation lock. Defaults to a fresh {@link TargetLock}. */
  lock?: TargetLock;
  /** Injected child spawner for phase jobs. */
  spawn?: PhaseRouteDeps["spawn"];
  /** Sparra binary override forwarded to phase spawns. */
  sparraBin?: string;
  /** Read-only status source for `GET /projects`. */
  statusSource?: PhaseRouteDeps["statusSource"];
  /** Core role runner for `/role` and `/unit`. */
  runRole?: ConductorRouteDeps["runRole"];
  /** Core unit runner for `/unit`. */
  runUnit?: ConductorRouteDeps["runUnit"];
  /** Asset reader for `GET /` (the dashboard) — ONE call returning both files. Defaults to reading
   *  the real `dashboard.html`/`dashboard.client.js` next to this package. */
  readDashboardAssets?: DashboardRouteDeps["readAssets"];
  /** The shared events feed backing `GET /events`. Defaults to a fresh no-sink {@link EventLog} (a
   *  test that omits it gets an isolated, empty log); a live bridge passes the SAME instance its
   *  `JobStore` emits into, via `startBridge`. */
  eventLog?: EventLog;
}

/** Build every bridge route (phases + conductor) over one shared {@link TargetLock}. */
export function registerBridgeRoutes(deps: BridgeRouteDeps = {}): RouteDefinition[] {
  const lock = deps.lock ?? new TargetLock();

  const phaseDeps: PhaseRouteDeps = {
    lock,
    ...(deps.spawn !== undefined ? { spawn: deps.spawn } : {}),
    ...(deps.sparraBin !== undefined ? { sparraBin: deps.sparraBin } : {}),
    ...(deps.statusSource !== undefined ? { statusSource: deps.statusSource } : {}),
  };
  const conductDeps: ConductRouteDeps = {
    lock,
    ...(deps.spawn !== undefined ? { spawn: deps.spawn } : {}),
    ...(deps.sparraBin !== undefined ? { sparraBin: deps.sparraBin } : {}),
  };
  const conductorDeps: ConductorRouteDeps = {
    lock,
    ...(deps.runRole !== undefined ? { runRole: deps.runRole } : {}),
    ...(deps.runUnit !== undefined ? { runUnit: deps.runUnit } : {}),
  };
  const dashboardDeps: DashboardRouteDeps = {
    ...(deps.readDashboardAssets !== undefined ? { readAssets: deps.readDashboardAssets } : {}),
  };
  const eventLog = deps.eventLog ?? new EventLog();

  return [
    ...createPhaseRoutes(phaseDeps),
    ...createConductRoutes(conductDeps),
    ...createConductorRoutes(conductorDeps),
    ...createDashboardRoutes(dashboardDeps),
    ...createEventsRoutes({ eventLog }),
  ];
}
