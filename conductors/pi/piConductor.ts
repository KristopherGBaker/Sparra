import process from "node:process";
import { fileURLToPath } from "node:url";

import type { ParentSummary } from "../core/index.ts";

/**
 * Isolated-role runner via the Pi SDK — the PROGRAM-conductor pattern (a Pi agent session spawned
 * in-process, not the interactive `pi` CLI). Ports the pattern proven in the earlier spike.
 *
 * This module imports NOTHING from `@earendil-works/*` at the top level — the SDK is loaded via a
 * lazy `await import(...)` inside {@link runIsolatedRoleViaPiSdk} so that importing
 * `conductors/pi/index.ts` (and therefore this file) never loads Pi at runtime. `npm test` never
 * exercises this function; it is live-only, exercised by a smoke run that needs real model auth.
 */

const ROLE_WORKER_PATH = fileURLToPath(new URL("../core/roleWorker.ts", import.meta.url));

/** Options for {@link runIsolatedRoleViaPiSdk}. */
export interface RunIsolatedRoleViaPiSdkOptions {
  /** Model provider. Defaults to `"openai-codex"`. */
  provider?: string;
  /** Model id. Defaults to `"gpt-5.6-sol"`. */
  model?: string;
  /** Argv for the sparra CLI, forwarded to `conductors/core/roleWorker.ts`, e.g.
   *  `["role","run","--kind","evaluator"]`. */
  roleArgs?: string[];
  /** The sparra binary; inlined into the child session's `SPARRA_BIN` env if set. */
  sparraBin?: string;
  cwd?: string;
}

const DEFAULT_PROVIDER = "openai-codex";
const DEFAULT_MODEL = "gpt-5.6-sol";

/** Shell-quote one argv token for the isolated session's bash command. */
function shellQuote(token: string): string {
  return `'${token.replace(/'/g, `'\\''`)}'`;
}

/**
 * Spawn an isolated Pi agent session (tools limited to `["bash","read"]`) that runs
 * `conductors/core/roleWorker.ts` via `node --import tsx roleWorker.ts -- <roleArgs>`, and return
 * ONLY the parsed {@link ParentSummary} the worker printed to stdout. The raw envelope never
 * enters this (or the parent) process — the worker child is the only thing that parses it, and
 * only its stdout summary line crosses back.
 *
 * Throws a clear error if no model is available (e.g. auth absent) rather than silently no-op'ing
 * — this path is exercised by a live smoke run, not `npm test`.
 */
export async function runIsolatedRoleViaPiSdk(
  opts: RunIsolatedRoleViaPiSdkOptions = {},
): Promise<ParentSummary> {
  const provider = opts.provider ?? DEFAULT_PROVIDER;
  const model = opts.model ?? DEFAULT_MODEL;
  const roleArgs = opts.roleArgs ?? [];
  const cwd = opts.cwd ?? process.cwd();

  // Lazy import: this line is the ONLY place in `conductors/pi` (outside `extension.ts`) that
  // touches the Pi SDK, so importing this module (or `index.ts`, which re-exports this function)
  // never loads Pi at runtime — only calling it does.
  const { createAgentSession, SessionManager, AuthStorage, ModelRegistry } = await import(
    "@earendil-works/pi-coding-agent"
  );

  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const scopedModel = modelRegistry.find(provider, model);
  if (!scopedModel) {
    throw new Error(
      `runIsolatedRoleViaPiSdk: no model available for provider="${provider}" model="${model}" ` +
        `— is Pi authenticated (Codex OAuth) for this provider?`,
    );
  }

  const sessionManager = SessionManager.inMemory(cwd);
  const { session } = await createAgentSession({
    model: scopedModel,
    tools: ["bash", "read"],
    cwd,
    sessionManager,
    authStorage,
    modelRegistry,
  });

  try {
    const command = [
      "node",
      "--import",
      "tsx",
      shellQuote(ROLE_WORKER_PATH),
      "--",
      ...roleArgs.map(shellQuote),
    ].join(" ");
    const envPrefix = opts.sparraBin ? `SPARRA_BIN=${shellQuote(opts.sparraBin)} ` : "";
    const prompt =
      `Run exactly this shell command and report only its stdout:\n` + `${envPrefix}${command}`;

    let assistantText = "";
    const unsubscribe = session.subscribe((evt: unknown) => {
      const e = evt as { type?: string; assistantMessageEvent?: { type?: string; delta?: string } };
      if (e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta") {
        assistantText += e.assistantMessageEvent.delta ?? "";
      }
    });

    try {
      await session.prompt(prompt);
    } finally {
      unsubscribe();
    }

    const summaryLine = extractSummaryLine(assistantText);
    if (!summaryLine) {
      throw new Error(
        "runIsolatedRoleViaPiSdk: isolated session produced no parseable summary JSON " +
          "(expected the roleWorker's single-line stdout envelope)",
      );
    }
    return JSON.parse(summaryLine) as ParentSummary;
  } finally {
    session.dispose();
  }
}

/** Pick the last JSON-object-shaped line out of the session's accumulated assistant text — the
 *  roleWorker prints exactly one such line to stdout, but the session may narrate around it. */
function extractSummaryLine(text: string): string | undefined {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line && line.startsWith("{") && line.endsWith("}")) return line;
  }
  return undefined;
}
