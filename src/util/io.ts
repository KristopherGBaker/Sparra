import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export async function ensureDir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
}

export function ensureDirSync(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export async function readText(file: string): Promise<string | null> {
  try {
    return await fsp.readFile(file, "utf8");
  } catch {
    return null;
  }
}

export function readTextSync(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

export async function writeText(file: string, content: string): Promise<void> {
  await ensureDir(path.dirname(file));
  await fsp.writeFile(file, content, "utf8");
}

export async function appendText(file: string, content: string): Promise<void> {
  await ensureDir(path.dirname(file));
  await fsp.appendFile(file, content, "utf8");
}

export function exists(p: string): boolean {
  return fs.existsSync(p);
}

/** Directory entry names (non-recursive). Returns [] if the dir is absent or unreadable. */
export function readDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** Move/rename a file, creating the destination's parent dir first. */
export async function moveFile(src: string, dst: string): Promise<void> {
  await ensureDir(path.dirname(dst));
  await fsp.rename(src, dst);
}

/** Delete a file. Silently no-ops if it is already absent. */
export async function removeFile(p: string): Promise<void> {
  await fsp.rm(p, { force: true });
}

/** True iff `p` is itself a symlink (does NOT follow the link). False if absent or on stat error. */
export function isSymlink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

export async function readJson<T>(file: string): Promise<T | null> {
  const t = await readText(file);
  if (t == null) return null;
  try {
    return JSON.parse(t) as T;
  } catch {
    return null;
  }
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  await writeText(file, JSON.stringify(value, null, 2) + "\n");
}

/** A filesystem-safe timestamp like 2026-06-23T15-04-09. Caller supplies the date. */
export function stampFromDate(d: Date): string {
  return d.toISOString().replace(/:/g, "-").replace(/\..+$/, "");
}
