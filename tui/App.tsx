import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import chokidar from "chokidar";
import type { Ctx } from "../src/context.ts";
import type { SparraState, ItemState } from "../src/state.ts";
import { planTurn, planningOpeningPrompt } from "../src/phases/plan.ts";
import { newRunId } from "../src/context.ts";
import { activePause, applyDecision, readPauseSummary, PAUSE_DECISIONS, type Step } from "../src/build/interactive.ts";
import { readState, activeTraceFile, tailLines, spawnSparra, type ChildHandle } from "./lib.ts";

type View = "dashboard" | "plan" | "logs" | "pause";
const CAP = 400;

/** The interactive checkpoint the TUI is rendering a prompt for. */
interface PausePrompt {
  kind: Step;
  itemId: string;
  round: number;
  summary: string;
}

interface Msg {
  role: "you" | "planner";
  text: string;
}

export default function App({ ctx }: { ctx: Ctx }) {
  const { exit } = useApp();
  const [view, setView] = useState<View>("dashboard");
  const [state, setState] = useState<SparraState | null>(readState(ctx.paths));
  const [cost, setCost] = useState(0);

  // interview
  const [transcript, setTranscript] = useState<Msg[]>([]);
  const [streaming, setStreaming] = useState("");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const sessionRef = useRef<string | undefined>(ctx.store.data.planning.sessionId);
  const seqRef = useRef<number>(ctx.store.data.planning.turns);
  const startedRef = useRef(false);
  const planTraceDir = useRef<string>(ctx.paths.traceDir(newRunId("plan")));

  // logs / actions
  const [logs, setLogs] = useState<string[]>([]);
  const childRef = useRef<ChildHandle | null>(null);
  const [running, setRunning] = useState<string | null>(null);

  // interactive (`build --step`) pause prompt
  const [pause, setPause] = useState<PausePrompt | null>(null);

  // watch state.json + active trace for the dashboard
  const [traceTail, setTraceTail] = useState<string[]>([]);
  useEffect(() => {
    const refresh = () => {
      const s = readState(ctx.paths);
      setState(s);
      const tf = activeTraceFile(ctx.paths, s);
      if (tf) setTraceTail(tailLines(tf, 12).filter((l) => l.trim()));
    };
    refresh();
    const w = chokidar.watch([ctx.paths.state, ctx.paths.traces], { ignoreInitial: true, depth: 3 });
    w.on("all", refresh);
    const t = setInterval(refresh, 1500);
    return () => {
      w.close();
      clearInterval(t);
    };
  }, []);

  const pushLog = (line: string) => setLogs((p) => [...p, line].slice(-CAP));

  function runAction(label: string, args: string[], afterExit?: () => void) {
    if (running) {
      pushLog(`(${running} still running — press k to cancel)`);
      return;
    }
    setView("logs");
    setRunning(label);
    pushLog(`\n$ sparra ${args.join(" ")}`);
    childRef.current = spawnSparra(ctx.root, args, pushLog, (code) => {
      pushLog(`— ${label} exited (${code}) —`);
      setRunning(null);
      childRef.current = null;
      afterExit?.();
    });
  }

  // After a stepped build (or a resume) exits, surface an inline prompt if it paused at a
  // checkpoint. Reads fresh from disk — the exit closure's `state` may lag the watcher.
  function offerPausePrompt() {
    const s = readState(ctx.paths);
    const p = activePause(s);
    if (!p || !s?.build.runId) return;
    readPauseSummary(ctx.paths, s.build.runId, p.itemId)
      .then((summary) => {
        setPause({ kind: p.kind, itemId: p.itemId, round: p.round, summary });
        setView("pause");
      })
      .catch((err) => pushLog(`⚠ could not read pause summary: ${(err as Error).message}`));
  }

  // Record the human's decision to the pause folder, then resume with a plain `sparra build`
  // (interactive mode is remembered in state, so no --step on resume). Write failures surface in
  // the log instead of crashing the TUI.
  function submitPause(decision: string, reason: string, feedback: string) {
    const p = pause;
    const s = readState(ctx.paths);
    if (!p || !s?.build.runId) {
      setPause(null);
      setView("logs");
      return;
    }
    const runId = s.build.runId;
    setPause(null);
    setView("logs");
    applyDecision(ctx.paths, runId, p.itemId, {
      kind: p.kind,
      decision,
      reason: reason || undefined,
      feedback: feedback || undefined,
    })
      .then(() => {
        pushLog(`▸ ${p.itemId}: ${p.kind} → ${decision} — resuming…`);
        runAction("build (resume)", ["build"], offerPausePrompt);
      })
      .catch((err) => pushLog(`⚠ could not record decision (${(err as Error).message}); pause left intact — resume from a terminal.`));
  }

  async function submitTurn(userText: string) {
    if (busy) return;
    setBusy(true);
    setTranscript((p) => [...p, { role: "you" as const, text: userText }].slice(-CAP));
    setStreaming("");
    seqRef.current += 1;
    let acc = "";
    try {
      const res = await planTurn({
        ctx,
        userText,
        sessionId: sessionRef.current,
        traceDir: planTraceDir.current,
        traceSeq: seqRef.current,
        onText: (t) => {
          acc += t;
          setStreaming(acc);
        },
        onEvent: (e) => {
          if (e.kind === "result") setCost((c) => c + e.costUsd);
        },
      });
      sessionRef.current = res.sessionId || sessionRef.current;
      setTranscript((p) => [...p, { role: "planner" as const, text: acc || res.resultText }].slice(-CAP));
    } catch (err) {
      setTranscript((p) => [...p, { role: "planner" as const, text: `⚠ ${(err as Error).message}` }].slice(-CAP));
    } finally {
      setStreaming("");
      setBusy(false);
    }
  }

  function onInputSubmit(value: string) {
    const v = value.trim();
    setInput("");
    if (!v) return;
    if (v === "/snapshot") return runAction("snapshot", ["snapshot"]);
    if (v === "/freeze") return runAction("freeze", ["freeze"]);
    if (v === "/exit") return setView("dashboard");
    void submitTurn(v);
  }

  // keybindings
  useInput((ch, key) => {
    if (key.ctrl && ch === "c") {
      childRef.current?.kill();
      exit();
      return;
    }
    if (view === "plan") {
      if (key.escape) setView("dashboard");
      return; // let TextInput handle the rest
    }
    if (view === "pause") return; // the Pause component owns its own input (menu + TextInput)
    if (key.tab) {
      const order: View[] = ["dashboard", "plan", "logs"];
      setView(order[(order.indexOf(view) + 1) % order.length]!);
    }
    else if (ch === "d") setView("dashboard");
    else if (ch === "p") setView("plan");
    else if (ch === "l") setView("logs");
    else if (ch === "q") {
      childRef.current?.kill();
      exit();
    } else if (ch === "k") childRef.current?.kill();
    else if (ch === "s") runAction("snapshot", ["snapshot"]);
    else if (ch === "f") runAction("freeze", ["freeze"]);
    else if (ch === "b") runAction("build", ["build"]);
    else if (ch === "B") runAction("build --step", ["build", "--step=contract,round,commit,item"], offerPausePrompt);
    else if (ch === "r") runAction("reflect", ["reflect"]);
    else if (ch === "o") runAction("orient", ["orient"]);
  });

  // auto-kick the interview the first time you open it on a fresh plan
  useEffect(() => {
    if (view === "plan" && !startedRef.current) {
      startedRef.current = true;
      if (!sessionRef.current && transcript.length === 0) void submitTurn(planningOpeningPrompt(ctx));
    }
  }, [view]);

  return (
    <Box flexDirection="column">
      <Header state={state} cost={cost} running={running} />
      {view === "dashboard" && <Dashboard state={state} traceTail={traceTail} />}
      {view === "plan" && (
        <Interview transcript={transcript} streaming={streaming} busy={busy} input={input} setInput={setInput} onSubmit={onInputSubmit} />
      )}
      {view === "logs" && <Logs logs={logs} />}
      {view === "pause" && pause && <Pause prompt={pause} onSubmit={submitPause} />}
      <Footer view={view} busy={busy} />
    </Box>
  );
}

function Header({ state, cost, running }: { state: SparraState | null; cost: number; running: string | null }) {
  return (
    <Box borderStyle="round" borderColor="cyan" paddingX={1} justifyContent="space-between">
      <Text>
        <Text bold color="cyan">
          Sparra
        </Text>{" "}
        · {state?.mode ?? "?"} · phase <Text bold>{state?.phase ?? "?"}</Text>
        {running ? <Text color="yellow"> · running {running}…</Text> : null}
      </Text>
      <Text dimColor>session ${cost.toFixed(3)}</Text>
    </Box>
  );
}

function statusMark(s: string) {
  if (s === "passed") return <Text color="green">✓</Text>;
  if (s === "failed") return <Text color="red">✗</Text>;
  if (s === "abandoned") return <Text dimColor>⊘</Text>;
  if (s === "budget_exceeded") return <Text color="yellow">$</Text>;
  return <Text color="yellow">•</Text>;
}

function Dashboard({ state, traceTail }: { state: SparraState | null; traceTail: string[] }) {
  const items = Object.entries(state?.build.items ?? {}) as [string, ItemState][];
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>Work items</Text>
      {items.length === 0 ? (
        <Text dimColor> none yet — freeze a plan and start a build</Text>
      ) : (
        items.map(([id, it]) => (
          <Text key={id}>
            {" "}
            {statusMark(it.status)} {id} — {it.status} <Text dimColor>(round {it.round}, pivots {it.pivots}, score {it.lastScore ?? "-"})</Text>
          </Text>
        ))
      )}
      <Box marginTop={1} flexDirection="column">
        <Text bold>Live activity</Text>
        {traceTail.length === 0 ? (
          <Text dimColor> (idle)</Text>
        ) : (
          traceTail.map((l, i) => (
            <Text key={i} dimColor>
              {" "}
              {l.slice(0, 100)}
            </Text>
          ))
        )}
      </Box>
    </Box>
  );
}

function Interview(props: {
  transcript: Msg[];
  streaming: string;
  busy: boolean;
  input: string;
  setInput: (s: string) => void;
  onSubmit: (s: string) => void;
}) {
  const recent = props.transcript.slice(-8);
  return (
    <Box flexDirection="column" paddingX={1}>
      {recent.map((m, i) => (
        <Box key={i} flexDirection="column" marginBottom={1}>
          <Text bold color={m.role === "you" ? "green" : "cyan"}>
            {m.role === "you" ? "you" : "planner"}
          </Text>
          <Text>{m.text.trim()}</Text>
        </Box>
      ))}
      {props.streaming ? (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color="cyan">
            planner
          </Text>
          <Text>{props.streaming.trim()}</Text>
        </Box>
      ) : null}
      <Box>
        <Text color="green">{props.busy ? "… " : "you › "}</Text>
        {!props.busy && <TextInput value={props.input} onChange={props.setInput} onSubmit={props.onSubmit} placeholder="answer, or /snapshot /freeze /exit" />}
      </Box>
    </Box>
  );
}

function Logs({ logs }: { logs: string[] }) {
  const recent = logs.slice(-20);
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>Action log</Text>
      {recent.length === 0 ? <Text dimColor> (no actions yet — press b to build, r to reflect)</Text> : recent.map((l, i) => <Text key={i}>{l.slice(0, 120)}</Text>)}
    </Box>
  );
}

function Footer({ view, busy }: { view: View; busy: boolean }) {
  const keys =
    view === "plan"
      ? "type to answer · Enter send · Esc dashboard · Ctrl+C quit"
      : view === "pause"
      ? "↑/↓ choose · Enter select · type to add feedback/reason · Ctrl+C quit"
      : "[d]ash [p]lan [l]ogs · [o]rient [s]napshot [f]reeze [b]uild [B]uild-step [r]eflect · [k]ill [q]uit · Tab cycles";
  return (
    <Box borderStyle="round" borderColor="gray" paddingX={1}>
      <Text dimColor>{busy ? "planner is thinking…  " : ""}{keys}</Text>
    </Box>
  );
}

/** Inline prompt for a `build --step` checkpoint: shows the (already holdout-redacted) summary,
 *  a menu of the kind's allowed decisions, and — for a `round` — an optional feedback box (a reason
 *  box when accepting). On submit the parent records the decision via `applyDecision` and resumes.
 *  This component owns its own input; the app-level keybindings are suspended on the pause view. */
function Pause({ prompt, onSubmit }: { prompt: PausePrompt; onSubmit: (decision: string, reason: string, feedback: string) => void }) {
  const options = PAUSE_DECISIONS[prompt.kind];
  const [idx, setIdx] = useState(0);
  const [stage, setStage] = useState<"menu" | "feedback" | "reason">("menu");
  const [chosen, setChosen] = useState<string>(options[0] ?? "");
  const [text, setText] = useState("");

  useInput((ch, key) => {
    if (stage !== "menu") return; // a TextInput is focused — let it handle typing
    if (key.upArrow || ch === "k") setIdx((i) => (i + options.length - 1) % options.length);
    else if (key.downArrow || ch === "j") setIdx((i) => (i + 1) % options.length);
    else if (key.return) {
      const d = options[idx] ?? options[0] ?? "";
      setChosen(d);
      // `round` is the only kind that collects free text: feedback to steer continue/pivot, a
      // reason when accepting. Everything else submits immediately on selection.
      if (prompt.kind === "round" && (d === "continue" || d === "pivot")) setStage("feedback");
      else if (prompt.kind === "round" && d === "accept") setStage("reason");
      else onSubmit(d, "", "");
    }
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="yellow">
        ⏸ build paused — {prompt.kind} · {prompt.itemId}
        {prompt.kind === "round" ? ` (round ${prompt.round})` : ""}
      </Text>
      <Box flexDirection="column" marginY={1}>
        {prompt.summary.trim().split("\n").slice(0, 18).map((l, i) => (
          <Text key={i} dimColor>
            {l.slice(0, 110)}
          </Text>
        ))}
      </Box>
      {stage === "menu" ? (
        <Box flexDirection="column">
          <Text bold>Decide:</Text>
          {options.map((o, i) => (
            <Text key={o} color={i === idx ? "cyan" : undefined}>
              {i === idx ? "❯ " : "  "}
              {o}
            </Text>
          ))}
        </Box>
      ) : (
        <Box>
          <Text color="green">{stage === "reason" ? `reason (why accept) › ` : "feedback (steer next round) › "}</Text>
          <TextInput value={text} onChange={setText} onSubmit={(v) => onSubmit(chosen, stage === "reason" ? v : "", stage === "feedback" ? v : "")} placeholder="optional — Enter to submit" />
        </Box>
      )}
    </Box>
  );
}
