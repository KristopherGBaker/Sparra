import path from "node:path";
import type { Ctx } from "../context.ts";
import type { RoleConfig } from "../config.ts";
import { DEFAULT_PROMPTS, promptDrift, syncPrompts, promptRolePath } from "../prompts.ts";
import { auditPrompts } from "../build/promptAudit.ts";
import { banner, ok, info, warn, detail, color } from "../util/log.ts";

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
/** Parse a `--effort` flag into a valid RoleConfig effort, or undefined (use the role's config). */
function parseEffort(flag: unknown): RoleConfig["effort"] {
  return typeof flag === "string" && (EFFORTS as readonly string[]).includes(flag) ? (flag as RoleConfig["effort"]) : undefined;
}

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

  if (sub === "audit") {
    banner("prompt audit (conciseness)");
    const source = flags.source === "default" ? "default" : "effective";
    if (source === "default" && flags.apply) {
      info("source=default is report-only (applying would rewrite src/prompts.ts) — port proposals by hand.");
    }
    const rows = await auditPrompts(ctx, {
      roles: role ? [role] : undefined,
      source,
      apply: !!flags.apply,
      backend: typeof flags.backend === "string" ? flags.backend : undefined,
      model: typeof flags.model === "string" ? flags.model : undefined,
      effort: parseEffort(flags.effort),
    });
    for (const r of rows) {
      const sign = r.pctDelta <= 0 ? "" : "+";
      const status = r.applied
        ? color.green("applied")
        : r.skipped
          ? color.yellow(`skipped (${r.skipReason})`)
          : color.gray("report-only");
      detail(
        `${r.role}  ${r.sizeBefore.chars}→${r.sizeAfter.chars} chars (${sign}${r.pctDelta}%)  ` +
          `droppedNothing=${r.droppedNothing}  ${status}`
      );
    }
    info(`Reviews written to ${path.relative(ctx.root, path.join(ctx.paths.prompts, "audit"))}/<role>.md` +
      (flags.apply ? "" : "   ·   apply tightened (coverage-gated): sparra prompts audit --apply [--role <role>]"));
    return;
  }

  warn(`Unknown subcommand "${sub}". Use: sparra prompts [status|sync|audit] [--role <role>] [--dry-run] [audit: --source default|effective --apply --backend b --model m --effort e]`);
}
