import process from "node:process";

import { defaultConfig } from "../../src/config.ts";
import type { Ctx } from "../../src/context.ts";
import { Paths } from "../../src/paths.ts";
import { StateStore } from "../../src/state.ts";
import { parse } from "../../src/util/args.ts";
import { evalAliasFlags, validateRoleRunFlags } from "../../src/phases/role.ts";

/**
 * `test/helpers/argvAcceptance.ts` — a reusable, in-process, SPEND-FREE acceptance seam.
 *
 * Given a `RunRoleSpec`-style argv (`["role","run",…]` or the `eval [dir]` alias), it runs the argv
 * through the SAME argv→flags parsing the real bin uses (`parse` from `src/util/args.ts`) and then the
 * SAME pre-model role-run validation layer the real `cmdRoleRun` runs (`validateRoleRunFlags` +
 * `evalAliasFlags` from `src/phases/role.ts`). There is exactly ONE source of truth for both the alias
 * mapping and the validation rules — this seam re-implements neither, so a builder's argv is
 * drift-proofed against the real parser/validator by construction.
 *
 * It runs FULLY in-process: no subprocess spawn, no SDK/session/model call, no filesystem writes. The
 * only reads are whatever the validators already perform (a no-op for the conduct specs, which set no
 * `--baseline-command`/`--expected-head`/`--eval-base`). The `Ctx` it builds is a minimal in-memory
 * greenfield context (mirroring `loadCtxForRole`'s greenfield fallback) — enough for the validation
 * prefix, which reads only `ctx.root` + `ctx.config.build.verifyCommands`.
 */

/** Outcome of running an argv through the seam. `accepted: false` always carries a `reason`. */
export interface ArgvAcceptResult {
  accepted: boolean;
  /** Human-readable rejection reason (the exact error the real CLI would surface). */
  reason?: string;
  /** The resolved role kind on acceptance (e.g. `"evaluator"` for an `eval` alias). */
  kind?: string;
}

/** A minimal in-memory `Ctx` (no FS writes, no model call) — mirrors `loadCtxForRole`'s greenfield
 *  fallback. Only `root` + `config.build.verifyCommands` are read by the validation prefix. */
function seamCtx(root: string): Ctx {
  const paths = new Paths(root);
  const store = StateStore.create(paths, "greenfield");
  return { root, paths, config: defaultConfig(), store };
}

/**
 * Run `argv` through the real parser + role-run validation layer, in-process. Accepts a `role run …`
 * command or the `eval [dir]` alias (normalized exactly as `src/cli.ts` does, via the shared
 * `evalAliasFlags`). Returns a deterministic accept/reject; a reject names why (invalid kind, missing
 * brief, bad provenance/baseline, or an unsupported command shape). Never throws for a validation
 * failure — the throw is caught and returned as a reason.
 */
export function acceptArgv(argv: string[], opts?: { root?: string }): ArgvAcceptResult {
  const root = opts?.root ?? process.cwd();
  const { positionals, flags } = parse(argv);

  let effectiveFlags: Record<string, string | boolean | string[]>;
  if (positionals[0] === "eval") {
    // `eval [dir] …` is the alias for `role run --kind evaluator …`.
    effectiveFlags = evalAliasFlags(positionals, flags);
  } else if (positionals[0] === "role" && positionals[1] === "run") {
    effectiveFlags = flags;
  } else {
    return {
      accepted: false,
      reason: `unsupported command: expected "role run …" or "eval …", got ${JSON.stringify(
        positionals.slice(0, 2),
      )}`,
    };
  }

  try {
    const req = validateRoleRunFlags(seamCtx(root), effectiveFlags);
    return { accepted: true, kind: req.roleKind };
  } catch (e) {
    return { accepted: false, reason: (e as Error).message };
  }
}
