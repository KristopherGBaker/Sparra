import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Ctx } from "../context.ts";
import type { ResolvedSkill } from "./backend.ts";
import { exists, readText } from "../util/io.ts";
import { warn } from "../util/log.ts";

/** Roles that inherit `build.skills` by default. Others (evaluator, reviewer, …) only
 *  get skills if their role config lists them explicitly — keeps grading/judging lean. */
const INHERIT_BUILD_SKILLS = new Set(["generator", "prototyper"]);

/** Candidate directories a bare skill name might live in (first with a SKILL.md wins). */
function candidateDirs(name: string, root: string): string[] {
  // Explicit path (absolute or relative) → use as-is.
  if (name.startsWith("/") || name.startsWith(".") || name.includes("/")) {
    return [path.resolve(root, name)];
  }
  const home = os.homedir();
  return [
    path.join(root, "skills", name),
    path.join(root, ".claude", "skills", name),
    path.join(home, ".claude", "skills", name),
    path.join(home, ".agents", "skills", name),
  ];
}

/** Resolve declared skill names/paths to {name, dir, skillMd}. Missing skills warn + skip
 *  (never fail a build over a missing skill). */
export function resolveSkills(names: string[], root: string): ResolvedSkill[] {
  const out: ResolvedSkill[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;
    const dir = candidateDirs(name, root).find((d) => exists(path.join(d, "SKILL.md")));
    if (!dir) {
      warn(`skill "${name}" not found (looked in repo skills/, ~/.claude/skills, ~/.agents/skills) — skipping.`);
      continue;
    }
    const skillMd = fs.readFileSync(path.join(dir, "SKILL.md"), "utf8");
    out.push({ name: path.basename(dir), dir, skillMd });
  }
  return out;
}

/** The effective resolved skills for a role: its explicit `skills`, else `build.skills`
 *  for builder roles, else none. */
export function skillsForRole(ctx: Ctx, roleName: string): ResolvedSkill[] {
  const role = (ctx.config.roles as Record<string, { skills?: string[] }>)[roleName];
  const names = role?.skills ?? (INHERIT_BUILD_SKILLS.has(roleName) ? ctx.config.build.skills ?? [] : []);
  if (!names.length) return [];
  return resolveSkills(names, ctx.root);
}

/**
 * Inline skill block for backends without native skill loading (e.g. Codex): the SKILL.md
 * bodies are injected into the system prompt so the role still gets the guidance, regardless
 * of where the skill lives. Each body is capped so several skills can't blow up the prompt.
 */
export function inlineSkillsBlock(skills: ResolvedSkill[]): string {
  if (!skills.length) return "";
  const cap = 8000;
  const blocks = skills
    .map((s) => `### Skill: ${s.name}\n${s.skillMd.length > cap ? s.skillMd.slice(0, cap) + "\n…(truncated)" : s.skillMd}`)
    .join("\n\n");
  return `\n\n## Available skills\nYou have these skills available — follow their guidance whenever relevant to the task.\n\n${blocks}\n`;
}

/**
 * Build a throwaway local plugin that wraps the resolved skills, for the Claude SDK's
 * `plugins` + `skills` options. This is how skills load while `settingSources` stays `[]`
 * (no ambient leak): only the declared skills are discoverable. Returns the plugin path,
 * the enable-list, and a cleanup fn the caller must call when the session ends.
 */
export function buildSkillPlugin(skills: ResolvedSkill[]): { path: string; names: string[]; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-skills-"));
  fs.mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "sparra-skills", version: "0.0.1" }));
  const skillsRoot = path.join(dir, "skills");
  fs.mkdirSync(skillsRoot, { recursive: true });
  for (const s of skills) {
    fs.cpSync(s.dir, path.join(skillsRoot, s.name), { recursive: true, dereference: true });
  }
  return {
    path: dir,
    names: skills.map((s) => s.name),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}
