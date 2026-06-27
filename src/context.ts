import { loadConfig, type SparraConfig } from "./config.ts";
import { Paths } from "./paths.ts";
import { StateStore } from "./state.ts";
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

/** A run id / trace dir for a phase invocation. */
export function newRunId(prefix: string): string {
  return `${prefix}-${stampFromDate(new Date())}`;
}
