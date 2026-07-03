import type { SparraConfig } from "../config.ts";

/** String-only copy of process.env; Node's type permits undefined values, SDK env maps do not. */
export function stringProcessEnv(src: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(src)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/** SDKs replace inherited env when env is provided, so Sparra merges explicitly first. */
export function mergedBuildEnv(config: SparraConfig, src: NodeJS.ProcessEnv = process.env): Record<string, string> | undefined {
  const buildEnv = config.build.env ?? {};
  if (!Object.keys(buildEnv).length) return undefined;
  return { ...stringProcessEnv(src), ...buildEnv };
}
