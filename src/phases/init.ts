import { loadConfig, writeDefaultConfig } from "../config.ts";
import { detect } from "../detect.ts";
import { Paths } from "../paths.ts";
import { seedPrompts } from "../prompts.ts";
import { StateStore, type Mode } from "../state.ts";
import { exists, writeText } from "../util/io.ts";
import { banner, detail, info, ok, warn } from "../util/log.ts";
import { isGitRepo } from "../util/git.ts";

export async function cmdInit(root: string, opts: { mode?: Mode; force?: boolean; docs?: string }): Promise<void> {
  banner("sparra init");
  // `--docs <dir>` sets the human-facing docs subfolder (PLAN.md, CODEBASE_MAP.md,
  // CHANGELOG.md, HOLDOUT.md); on re-init, keep the already-configured one.
  const docsDir = opts.docs ?? (await loadConfig(new Paths(root))).docsDir;
  const paths = new Paths(root, docsDir);

  const existingStore = await StateStore.load(paths);
  if (existingStore && !opts.force) {
    info(`Already initialized (phase: ${existingStore.data.phase}, mode: ${existingStore.data.mode}).`);
    detail("Use --force to re-detect and re-scaffold (your PLAN.md/config are preserved).");
    return;
  }

  const d = detect(root, opts.mode);
  info(`Detected mode: ${d.mode}${d.light ? " (light: partial scaffolding present)" : ""}`);
  for (const s of d.signals) detail(s);
  if (d.signals.length === 0) detail("empty directory — clean greenfield");

  await paths.ensureScaffold();
  await writeDefaultConfig(paths, d.mode, docsDir);
  await seedPrompts(paths);

  if (!exists(paths.plan)) {
    await writeText(
      paths.plan,
      `# Plan: (untitled)\n\n> Co-edited with Sparra during \`sparra plan\`. High-level intent, not granular steps.\n\n## Intent\n_TBD — what are we building and why?_\n\n## Constraints\n_TBD_\n\n## Approach\n_TBD (high level)_\n\n${d.mode === "existing" ? "## Patterns to conform to\n_See CODEBASE_MAP.md; filled during planning._\n\n" : ""}## Risks & unknowns\n_TBD_\n\n## Open questions\n_TBD_\n\n## Success criteria\n_TBD_\n`
    );
  }
  if (!exists(paths.changelog)) {
    await writeText(paths.changelog, `# Changelog\n\nDeviations from the plan, with rationale, recorded during the autonomous build.\n`);
  }

  const store = existingStore ?? StateStore.create(paths, d.mode);
  store.data.mode = d.mode;
  // First-time phase: existing → orient, greenfield → plan.
  if (!existingStore) {
    store.data.phase = d.mode === "existing" ? "orient" : "plan";
  }
  await store.save();

  ok(`Scaffolded .sparra/ and seeded config + prompts.`);
  detail(`config: .sparra/config.yaml   prompts: .sparra/prompts/`);
  if (docsDir) detail(`docs: ${docsDir}/ (PLAN.md, CODEBASE_MAP.md, CHANGELOG.md, HOLDOUT.md)`);
  if (d.mode === "existing") {
    if (!isGitRepo(root)) warn("Existing repo but no git detected — worktree/branch safety will fall back to in-place.");
    info("Next: `sparra orient` to map the codebase → CODEBASE_MAP.md");
  } else {
    info("Next: `sparra plan` to start the collaborative planning interview.");
  }
}
