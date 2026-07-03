import type { Paths } from "./paths.ts";
import { readText } from "./util/io.ts";

export async function readEnvironmentNotes(paths: Paths): Promise<string> {
  return ((await readText(paths.environment)) ?? "").trim();
}

export async function environmentNotesSection(paths: Paths): Promise<string> {
  const notes = await readEnvironmentNotes(paths);
  if (!notes) return "";
  return `\nEnvironment notes from .sparra/environment.md (heed these facts while running tools):\n---\n${notes.slice(0, 4000)}\n---\n`;
}
