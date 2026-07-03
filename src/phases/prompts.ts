import path from "node:path";
import type { Ctx } from "../context.ts";
import type { RoleConfig } from "../config.ts";
import { DEFAULT_PROMPTS, promptDrift, syncPrompts, promptRolePath, summarizePromptDrift } from "../prompts.ts";
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

  const summary = summarizePromptDrift(drift);

  if (sub === "status") {
    banner("prompt sync status");
    const tagFor = (state: string): string =>
      state === "same"
        ? color.gray("in sync")
        : state === "missing"
          ? color.yellow("MISSING")
          : state === "stale"
            ? color.yellow("STALE  ") // newer default available (adoptable)
            : state === "local"
              ? color.gray("local  ") // your edit; no update available
              : state === "conflict"
                ? color.yellow("CONFLICT")
                : color.yellow("DRIFTED"); // legacy: no baseline to classify
    for (const d of drift) detail(`${tagFor(d.state)}  ${d.role}`);
    if (!changed.length) {
      ok("All role prompts match the built-in defaults.");
      return;
    }
    if (summary.stale.length)
      info(`STALE — a newer default is available for: ${summary.stale.join(", ")}. Adopt with \`sparra prompts sync\`.`);
    if (summary.conflict.length)
      info(`CONFLICT — both your edit and the default moved for: ${summary.conflict.join(", ")}. Force with \`sparra prompts sync --role <role>\` (discards your edit).`);
    if (summary.local.length) info(`local edits (no update available): ${summary.local.join(", ")}.`);
    if (summary.drifted.length) info(`drifted (no baseline to classify — legacy): ${summary.drifted.join(", ")}.`);
    info("Inspect: .sparra/prompts/<role>.md   ·   adopt: sparra prompts sync [--role <role>|--all] [--dry-run]");
    return;
  }

  if (sub === "sync") {
    const all = flags.all === true;
    // Which roles get overwritten:
    //   --role X → force that one role regardless of state (DISCARDS local edits).
    //   --all    → every non-`same` role (prior default behavior; strong warning).
    //   (bare)   → adopt STALE only (the safe ones); local/conflict/drifted are left untouched.
    // Roles a bare sync deliberately does NOT touch, but must REPORT (never swallow into "all
    // match"): your edits, conflicts, unclassifiable legacy drift, and absent files.
    const bareSkipped = [...summary.conflict, ...summary.local, ...summary.drifted, ...summary.missing];
    const targets = role ? [role] : all ? changed.map((d) => d.role) : summary.stale;
    if (!targets.length) {
      if (!role && !all && bareSkipped.length) {
        ok("Nothing safe to sync — no prompt has a newer default (`stale`).");
        info(`Skipped (your edits / conflicts / unclassifiable / missing): ${bareSkipped.join(", ")}. Force adoption with \`sparra prompts sync --role <role>\` or \`--all\` (DISCARDS local edits).`);
        return;
      }
      ok("Nothing to sync — all prompts already match the defaults.");
      return;
    }
    if (flags["dry-run"]) {
      banner("prompts sync (dry run)");
      for (const r of targets) detail(`would overwrite ${promptRolePath(ctx.paths, r)} with the current default`);
      if (!role && !all) info("Adopting `stale` roles only (newer defaults). Re-run without --dry-run to write.");
      else info("Re-run without --dry-run to write. NOTE: sync DISCARDS local edits to those prompts (including reflect's).");
      return;
    }
    if (role || all) {
      warn(
        `Overwriting ${all ? "ALL changed" : "the selected"} prompt(s) with the built-in defaults — this DISCARDS any local edits (including reflect's).`
      );
    } else {
      info("Adopting only `stale` prompt(s) (a newer default with no local edit) — your local edits are left untouched.");
    }
    const written = await syncPrompts(ctx.paths, { roles: targets });
    ok(`Synced ${written.length} prompt(s): ${written.join(", ")}`);
    // After a bare sync, surface anything deliberately skipped so it's not silently dropped.
    if (!role && !all && bareSkipped.length) {
      info(`Left untouched (your edits / conflicts / unclassifiable / missing): ${bareSkipped.join(", ")}. Force with \`sparra prompts sync --role <role>\` or \`--all\`.`);
    }
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

  warn(`Unknown subcommand "${sub}". Use: sparra prompts [status|sync|audit] [--role <role>] [--all] [--dry-run] [audit: --source default|effective --apply --backend b --model m --effort e]`);
}
