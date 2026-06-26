import type { Ctx } from "../context.ts";
import { DEFAULT_PROMPTS, promptDrift, syncPrompts, promptRolePath } from "../prompts.ts";
import { banner, ok, info, warn, detail, color } from "../util/log.ts";

/**
 * `sparra prompts [status|sync] [--role <role>] [--dry-run]`
 *
 * Inspect and reconcile the project's `.sparra/prompts/<role>.md` against Sparra's current
 * built-in defaults. `init` snapshots the defaults; later Sparra improvements don't propagate, so
 * a project's prompts can quietly go stale. Drift can also be intentional (your edits / reflect),
 * so `sync` is explicit and never runs automatically.
 */
export async function cmdPrompts(
  ctx: Ctx,
  args: string[],
  flags: Record<string, unknown>
): Promise<void> {
  const sub = (args[0] ?? "status").toLowerCase();
  const role = typeof flags.role === "string" ? flags.role : undefined;

  if (role && !(role in DEFAULT_PROMPTS)) {
    warn(`Unknown role "${role}". Known roles: ${Object.keys(DEFAULT_PROMPTS).join(", ")}.`);
    return;
  }

  const drift = await promptDrift(ctx.paths);
  const changed = drift.filter((d) => d.state !== "same");

  if (sub === "status") {
    banner("prompt sync status");
    for (const d of drift) {
      const tag =
        d.state === "same"
          ? color.gray("in sync")
          : d.state === "missing"
            ? color.yellow("MISSING")
            : color.yellow("DRIFTED");
      detail(`${tag}  ${d.role}`);
    }
    if (!changed.length) {
      ok("All role prompts match the built-in defaults.");
      return;
    }
    info(
      `${changed.length} prompt(s) differ from the defaults — could be YOUR edits (or reflect's), ` +
        `or defaults that have since improved.`
    );
    info("Inspect: .sparra/prompts/<role>.md   ·   adopt defaults: sparra prompts sync [--role <role>] [--dry-run]");
    return;
  }

  if (sub === "sync") {
    const targets = role ? [role] : changed.map((d) => d.role);
    if (!targets.length) {
      ok("Nothing to sync — all prompts already match the defaults.");
      return;
    }
    if (flags["dry-run"]) {
      banner("prompts sync (dry run)");
      for (const r of targets) detail(`would overwrite ${promptRolePath(ctx.paths, r)} with the current default`);
      info("Re-run without --dry-run to write. NOTE: sync DISCARDS local edits to those prompts (including reflect's).");
      return;
    }
    warn("Overwriting local prompt(s) with the built-in defaults — this DISCARDS any local edits (including reflect's).");
    const written = await syncPrompts(ctx.paths, { roles: role ? [role] : undefined });
    ok(`Synced ${written.length} prompt(s): ${written.join(", ")}`);
    return;
  }

  warn(`Unknown subcommand "${sub}". Use: sparra prompts [status|sync] [--role <role>] [--dry-run]`);
}
