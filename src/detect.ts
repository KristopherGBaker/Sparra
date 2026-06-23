import fs from "node:fs";
import path from "node:path";
import type { Mode } from "./state.ts";

const MANIFESTS = [
  "package.json",
  "Cargo.toml",
  "Package.swift",
  "go.mod",
  "pyproject.toml",
  "setup.py",
  "pom.xml",
  "build.gradle",
  "Gemfile",
  "composer.json",
  "CMakeLists.txt",
];

const SOURCE_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rs", ".go", ".swift", ".java", ".kt", ".rb", ".php",
  ".c", ".cc", ".cpp", ".h", ".hpp", ".cs", ".scala", ".clj",
]);

// Things that are NOT evidence of an existing codebase.
const IGNORE_DIRS = new Set([".git", ".sparra", "node_modules", "prototypes", "dist", "build", ".venv", "venv", "target", ".next"]);
const IGNORE_FILES = new Set(["README.md", "LICENSE", "LICENSE.md", "CODEBASE_MAP.md", "PLAN.md", "CHANGELOG.md", ".gitignore", ".DS_Store"]);

export interface Detection {
  mode: Mode;
  light: boolean; // greenfield-light: partial scaffolding present
  signals: string[];
  sourceFileCount: number;
}

function countSources(dir: string, depth = 0, max = 6): { count: number; manifests: string[] } {
  let count = 0;
  const manifests: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { count, manifests };
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (IGNORE_DIRS.has(e.name) || (e.name.startsWith(".") && depth === 0)) continue;
      if (depth < max) {
        const sub = countSources(path.join(dir, e.name), depth + 1, max);
        count += sub.count;
        manifests.push(...sub.manifests);
      }
    } else if (e.isFile()) {
      if (IGNORE_FILES.has(e.name)) continue;
      if (MANIFESTS.includes(e.name)) manifests.push(e.name);
      if (SOURCE_EXT.has(path.extname(e.name))) count++;
    }
  }
  return { count, manifests };
}

function hasGitHistory(root: string): boolean {
  try {
    const headsDir = path.join(root, ".git", "refs", "heads");
    if (fs.existsSync(headsDir) && fs.readdirSync(headsDir).length > 0) return true;
    // packed-refs covers repos with no loose heads
    return fs.existsSync(path.join(root, ".git", "packed-refs"));
  } catch {
    return false;
  }
}

/** Heuristic detection, overridable via --mode. */
export function detect(root: string, override?: Mode): Detection {
  const { count, manifests } = countSources(root);
  const git = hasGitHistory(root);
  const signals: string[] = [];
  if (count > 0) signals.push(`${count} source file(s)`);
  if (manifests.length) signals.push(`manifest(s): ${[...new Set(manifests)].join(", ")}`);
  if (git) signals.push("git history present");

  if (override) {
    return { mode: override, light: override === "greenfield" && (count > 0 || manifests.length > 0), signals, sourceFileCount: count };
  }

  // Existing if there is a meaningful body of source, OR a manifest + any git history.
  const existing = count >= 3 || (manifests.length > 0 && (count >= 1 || git));
  if (existing) {
    return { mode: "existing", light: false, signals, sourceFileCount: count };
  }
  // Greenfield-light: scaffolding (a manifest, or a couple of files) but ~no source.
  const light = manifests.length > 0 || count > 0;
  return { mode: "greenfield", light, signals, sourceFileCount: count };
}
