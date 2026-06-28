import { loadConfig, type SparraConfig } from "./config.ts";
import { Paths } from "./paths.ts";
import { StateStore } from "./state.ts";
import { ensureAutoProbed } from "./sdk/guard.ts";
import { stampFromDate } from "./util/io.ts";

export interface Ctx {
  root: string;
  paths: Paths;
  config: SparraConfig;
  store: StateStore;
}

/** Load full context; throws if the project hasn't been `sparra init`-ed. */
export async function loadCtx(root: string): Promise<Ctx> {
  // config.yaml lives at root/.sparra (independent of docsDir), so load it first
  // to learn the docs subfolder, then build Paths with it.
  const config = await loadConfig(new Paths(root));
  const paths = new Paths(root, config.docsDir);
  const store = await StateStore.load(paths);
  if (!store) {
    throw new Error(`Not a Sparra project (no .sparra/state.json). Run \`sparra init\` first.`);
  }
  return { root, paths, config, store };
}

/**
 * Load context for the STANDALONE role-runner surfaces (`sparra eval`, `sparra role
 * run`, the MCP `run_role` tool) — works in a repo with NO `.sparra/` directory,
 * without requiring `sparra init` first.
 *
 * Unlike `loadCtx` (which requires an initialized project for the full phase loop),
 * this never throws on a fresh repo: `loadConfig` already falls back to
 * `defaultConfig()` when `.sparra/config.yaml` is absent (and uses the file unchanged
 * when present), and built-in `DEFAULT_PROMPTS` cover any missing prompt files. When
 * there is no `.sparra/state.json` we synthesize an IN-MEMORY greenfield store — we do
 * NOT `save()` it or scaffold `.sparra/`, so a config-less read never litters the
 * user's repo root. (`.sparra/` may still be created LAZILY by a writer when the run
 * actually emits a trace/verdict — that's fine.)
 *
 * Like the build PHASE (`src/phases/build.ts`), this probes whether `auto` permission mode is
 * available so interactive writer roles get the richer model-classifier mode — but only when
 * `config.permission.mode` wants auto. The probe is cached in `state.autoSupported` when a real
 * `state.json` exists, and set IN MEMORY only (never persisted) for a synthesized greenfield
 * store, so a config-less read never litters `.sparra/`. Inject `opts.probeAuto` in tests to
 * stay offline (the default calls the live SDK probe via `ensureAutoProbed`).
 */
export async function loadCtxForRole(
  root: string,
  opts: { probeAuto?: (ctx: Ctx, persisted: boolean) => Promise<void> } = {}
): Promise<Ctx> {
  const config = await loadConfig(new Paths(root));
  const paths = new Paths(root, config.docsDir);
  // An existing state.json is honored; otherwise an in-memory greenfield store (no save).
  const loaded = await StateStore.load(paths);
  const store = loaded ?? StateStore.create(paths, "greenfield");
  const ctx: Ctx = { root, paths, config, store };
  // Persist the probe result only when backed by a real state.json (else memory-only: no litter).
  const probeAuto = opts.probeAuto ?? ((c, persisted) => ensureAutoProbed(c, { persist: persisted }));
  await probeAuto(ctx, !!loaded);
  return ctx;
}

/** A run id / trace dir for a phase invocation. */
export function newRunId(prefix: string): string {
  return `${prefix}-${stampFromDate(new Date())}`;
}
