/**
 * `conductors/http/bridgeScript.test.ts` — exercises `skills/sparra-bridge/scripts/bridge.sh`'s
 * `conduct` + `decide` subcommands by sourcing it under bash with a STUBBED `curl` that captures the
 * request body. No sockets, no real bridge. Mirrors `packaging.test.ts`'s `spawnSync` discipline: if
 * `bash`/`jq` aren't available in the environment, the case is UN-RUN (returns), never a failure.
 *
 * Regression target (round-2 #13): `bridge conduct <root> <prompt>` (no optional extra-json) must
 * build + send the documented `{root, prompt}` JSON body and EXIT 0 — not print
 * `jq: invalid JSON text passed to --argjson`, send a bodyless POST, and mislead with exit 0. And an
 * INVALID extra-json must propagate a non-zero exit with NO curl call (no bodyless request).
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const bridgeSh = path.resolve(here, "../../skills/sparra-bridge/scripts/bridge.sh");

/** Sourced-bash runner that returns the captured curl body + call flag by reading a temp file. */
function runBridgeCapture(snippet: string): { status: number; body: string; called: boolean; stderr: string } | null {
  const capture = path.join(process.env.TMPDIR ?? "/tmp", `bridge-curl-${process.pid}-${Math.random().toString(36).slice(2)}.out`);
  const script = `
set -u
export SPARRA_BRIDGE_URL="http://127.0.0.1:0"
export SPARRA_BRIDGE_TOKEN="tok"
CAP="${capture}"
: > "$CAP"
curl() {
  echo CALLED >> "$CAP"
  local prev=""
  for a in "$@"; do
    if [ "$prev" = "-d" ]; then printf 'BODY %s\\n' "$a" >> "$CAP"; fi
    prev="$a"
  done
  echo '{"jobId":"j"}'
  return 0
}
source "$BRIDGE_SH"
${snippet}
rc=$?
cat "$CAP"
rm -f "$CAP"
exit $rc
`;
  const res = spawnSync("bash", ["-c", script], { encoding: "utf8", env: { ...process.env, BRIDGE_SH: bridgeSh } });
  if (res.error) return null; // no bash — UN-RUN
  const out = `${res.stdout ?? ""}`;
  const called = out.includes("CALLED");
  const bodyLine = out.split("\n").find((l) => l.startsWith("BODY "));
  const body = bodyLine ? bodyLine.slice("BODY ".length) : "";
  return { status: res.status ?? -1, body, called, stderr: `${res.stderr ?? ""}` };
}

function hasJq(): boolean {
  const r = spawnSync("jq", ["--version"], { encoding: "utf8" });
  return !r.error;
}

describe("bridge.sh — conduct/decide body construction (round-2 #13)", () => {
  it("`bridge conduct <root> <prompt>` (no extra-json) builds {root,prompt} and exits 0", () => {
    if (!hasJq()) return; // jq unavailable — UN-RUN
    const r = runBridgeCapture(`bridge conduct /tmp/root "build safely" >/dev/null`);
    if (r === null) return; // bash unavailable — UN-RUN
    expect(r.stderr).not.toMatch(/invalid JSON text/i);
    expect(r.status).toBe(0);
    expect(r.called).toBe(true);
    expect(JSON.parse(r.body)).toEqual({ root: "/tmp/root", prompt: "build safely" });
  });

  it("`bridge conduct` WITH extra-json merges the extra fields", () => {
    if (!hasJq()) return;
    const r = runBridgeCapture(`bridge conduct /tmp/root "go" '{"budget":5}' >/dev/null`);
    if (r === null) return;
    expect(r.status).toBe(0);
    expect(JSON.parse(r.body)).toEqual({ root: "/tmp/root", prompt: "go", budget: 5 });
  });

  it("INVALID extra-json → non-zero exit and NO curl call (never a bodyless request that looks like success)", () => {
    if (!hasJq()) return;
    const r = runBridgeCapture(`bridge conduct /tmp/root "go" 'not-json' >/dev/null 2>&1`);
    if (r === null) return;
    expect(r.status).not.toBe(0);
    expect(r.called).toBe(false);
  });

  it("`bridge decide <jobId> <seq> <answer> [note]` builds {seq,answer[,note]}", () => {
    if (!hasJq()) return;
    const noNote = runBridgeCapture(`bridge decide job-1 1 finalize >/dev/null`);
    if (noNote === null) return;
    expect(noNote.status).toBe(0);
    expect(JSON.parse(noNote.body)).toEqual({ seq: 1, answer: "finalize" });
    const withNote = runBridgeCapture(`bridge decide job-1 2 abandon "why" >/dev/null`);
    if (withNote === null) return;
    expect(JSON.parse(withNote.body)).toEqual({ seq: 2, answer: "abandon", note: "why" });
  });
});
