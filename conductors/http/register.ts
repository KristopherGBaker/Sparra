/**
 * `conductors/http/register.ts` — wire every trigger + conductor handler into U1's route registry.
 *
 * `registerBridgeRoutes` builds the phase routes and the conductor routes over a SINGLE shared
 * {@link TargetLock}, so a phase writer and a conductor writer contend on the SAME per-target lock
 * (a `/build` in flight blocks a `/unit` on that root, and vice versa). U1's `startBridge` calls this
 * so the running server exposes the full surface, without ever editing `server.ts`'s core routing.
 */

import { createConductorRoutes, type ConductorRouteDeps } from "./handlers/conductor.ts";
import { createPhaseRoutes, type PhaseRouteDeps } from "./handlers/phases.ts";
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
  const conductorDeps: ConductorRouteDeps = {
    lock,
    ...(deps.runRole !== undefined ? { runRole: deps.runRole } : {}),
    ...(deps.runUnit !== undefined ? { runUnit: deps.runUnit } : {}),
  };

  return [...createPhaseRoutes(phaseDeps), ...createConductorRoutes(conductorDeps)];
}
