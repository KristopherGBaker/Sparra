import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import chokidar from "chokidar";
import type { Ctx } from "../src/context.ts";
import type { SparraState, ItemState } from "../src/state.ts";
import { planTurn, planningOpeningPrompt } from "../src/phases/plan.ts";
import { newRunId } from "../src/context.ts";
import { readState, activeTraceFile, tailLines, spawnSparra, type ChildHandle } from "./lib.ts";

type View = "dashboard" | "plan" | "logs";
const CAP = 400;

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

  function runAction(label: string, args: string[]) {
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
    });
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
      : "[d]ash [p]lan [l]ogs · [o]rient [s]napshot [f]reeze [b]uild [r]eflect · [k]ill [q]uit · Tab cycles";
  return (
    <Box borderStyle="round" borderColor="gray" paddingX={1}>
      <Text dimColor>{busy ? "planner is thinking…  " : ""}{keys}</Text>
    </Box>
  );
}
