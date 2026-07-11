#!/usr/bin/env node
// Deterministic stand-in for `sparra role run … --json` / `sparra eval … --json`.
// Ignores argv (beyond honoring the presence of --json implicitly), prints exactly one canonical
// RunRolePayload envelope to stdout, and exits 0. Carries holdout-bearing fields (resultText /
// resultDigest / traceDir) with a canary sentinel so a conductor-core test can prove the summary
// projection strips them. Env knobs (used by the pool test):
//   STUB_ID        distinct per child → per-child canary + derived verdict/weightedTotal/model,
//                   so a concurrency test can prove no result mix-up / cross-talk.
//   STUB_DELAY_MS  artificial delay before writing stdout (prove real overlap under concurrency).
//   STUB_STDERR_NOISE  when set, emit a line to stderr first (prove stdout parsing ignores it).

const CANARY = "SPARRA_HOLDOUT_CANARY_DO_NOT_LEAK";
const stubId = process.env.STUB_ID || null;
const delayMs = Number(process.env.STUB_DELAY_MS) || 0;

function verdictFor(id) {
  if (id == null) return { verdict: "pass", weightedTotal: 88.5 };
  const match = /\d+/.exec(String(id));
  const index = match ? Number(match[0]) % 10 : 0;
  const weightedTotal = 50 + index * 10; // 50,60,70,80,…
  return { verdict: weightedTotal >= 75 ? "pass" : "fail", weightedTotal };
}

const canary = stubId ? `${CANARY}::${stubId}` : CANARY;
const { verdict, weightedTotal } = verdictFor(stubId);

const envelope = {
  roleKind: "evaluator",
  backend: "stub",
  model: stubId ? `stub-model-${stubId}` : "stub-model-1",
  ok: true,
  verdict,
  weightedTotal,
  passThreshold: 75,
  blocking: [],
  failedAssertions: [],
  verdictPath: stubId ? `/tmp/sparra-stub/${stubId}/verdict.md` : "/tmp/sparra-stub/verdict.md",
  outPath: stubId ? `/tmp/sparra-stub/${stubId}/out.md` : "/tmp/sparra-stub/out.md",
  filesChanged: 1,
  sameModelGrade: false,
  errors: [],
  tokens: 1234,
  costUsd: 0.01,
  // --- holdout-bearing / raw fields: must never reach the parent summary ---
  resultText:
    `Evaluator transcript (raw, holdout-adjacent): reference answer key for grading: ${canary}.`,
  resultDigest: "sha256:deadbeefcafefeed",
  traceDir: stubId ? `/tmp/sparra-stub/trace-${stubId}` : "/tmp/sparra-stub/trace",
};

function emit() {
  if (process.env.STUB_STDERR_NOISE) process.stderr.write("[stub] human log line, not JSON\n");
  process.stdout.write(JSON.stringify(envelope) + "\n");
  process.exit(0);
}

if (delayMs > 0) setTimeout(emit, delayMs);
else emit();
