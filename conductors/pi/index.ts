/**
 * `conductors/pi` — the Pi conductor adapter over `conductors/core`.
 *
 * This barrel exports ONLY the Pi-FREE surface: importing it never loads the Pi SDK or typebox at
 * runtime (`roleRunner.ts` has no such imports at all; `loopCommand.ts` imports `ExtensionAPI`/
 * `ExtensionCommandContext` as TYPES only, erased at build time; `piConductor.ts` lazy-imports Pi
 * only inside {@link runIsolatedRoleViaPiSdk}). The real Pi extension entrypoint,
 * `conductors/pi/extension.ts`, is NOT re-exported here — its top-level `@earendil-works/*` /
 * `typebox` imports would load Pi the moment this module is imported, defeating the point (and
 * breaking `npm test`, which imports this barrel offline). Load `extension.ts` directly as Pi's
 * extension entrypoint instead.
 */

export {
  runSparraRoleForTool,
  renderSummaryText,
  type SparraRoleToolInput,
  type SparraRoleToolOutput,
  type RunSparraRoleForToolDeps,
} from "./roleRunner.ts";

export {
  runIsolatedRoleViaPiSdk,
  type RunIsolatedRoleViaPiSdkOptions,
} from "./piConductor.ts";

export {
  buildLoopConfig,
  parseLoopCommandArgs,
  registerSparraLoopCommand,
  renderLoopReport,
} from "./loopCommand.ts";

export type { ParentSummary, RunRolePayload, RunRoleSpec } from "../core/index.ts";
