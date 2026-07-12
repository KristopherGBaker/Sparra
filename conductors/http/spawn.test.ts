import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { JobStore } from "./jobs.ts";
import { spawnPhase, TargetLock, type SpawnFn, type SpawnedChild } from "./spawn.ts";

/** A controllable fake child process: emit stdout/stderr/close/error on demand, record kill signals. */
class FakeChild extends EventEmitter implements SpawnedChild {
  // Real EventEmitters (structurally satisfy SpawnedChild's `{ on(...) }`) so the test can `emit`.
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly signals: (NodeJS.Signals | number)[] = [];
  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(signal ?? "SIGTERM");
    return true;
  }
}

interface Harness {
  child: FakeChild;
  spawn: SpawnFn;
  calls: { command: string; args: string[]; options: { cwd?: string; env?: NodeJS.ProcessEnv } }[];
}

function fakeSpawn(): Harness {
  const child = new FakeChild();
  const calls: Harness["calls"] = [];
  const spawn: SpawnFn = (command, args, options) => {
    calls.push({ command, args, options });
    return child;
  };
  return { child, spawn, calls };
}

describe("spawnPhase — tracked subprocess launcher", () => {
  it("spawns the repo bin/sparra.mjs under the current node with cwd = the guarded root", () => {
    const jobs = new JobStore({ genId: () => "j1" });
    const job = jobs.createJob({ kind: "build", root: "/tmp/root" });
    const { spawn, calls } = fakeSpawn();
    spawnPhase(job, { args: ["build", "--fresh"], cwd: "/tmp/root" }, { jobs, spawn });
    expect(calls).toHaveLength(1);
    // A `.mjs` bin runs under the current node: command is the node exec path, argv[0] is the bin.
    expect(calls[0]!.command).toBe(process.execPath);
    expect(calls[0]!.args[0]).toMatch(/bin\/sparra\.mjs$/);
    expect(calls[0]!.args.slice(1)).toEqual(["build", "--fresh"]);
    expect(calls[0]!.options.cwd).toBe("/tmp/root");
  });

  it("honors an explicit sparraBin override", () => {
    const jobs = new JobStore({ genId: () => "j1" });
    const job = jobs.createJob({ kind: "build" });
    const { spawn, calls } = fakeSpawn();
    spawnPhase(job, { sparraBin: "/opt/custom/sparra", args: ["freeze"], cwd: "/tmp/root" }, { jobs, spawn });
    // A non-js bin is treated as a PATH executable, run directly.
    expect(calls[0]!.command).toBe("/opt/custom/sparra");
    expect(calls[0]!.args).toEqual(["freeze"]);
  });

  it("streams stdout AND stderr into the job log via appendLog", () => {
    const jobs = new JobStore({ genId: () => "j1" });
    const job = jobs.createJob({ kind: "build" });
    const { child, spawn } = fakeSpawn();
    spawnPhase(job, { args: ["build"], cwd: "/tmp/root" }, { jobs, spawn });
    child.stdout!.emit("data", Buffer.from("out-line\n"));
    child.stderr!.emit("data", Buffer.from("err-line\n"));
    expect(jobs.getJob("j1")!.log).toBe("out-line\nerr-line\n");
  });

  it("on exit 0 finishes succeeded; non-zero finishes failed with exitCode", () => {
    const jobs = new JobStore({ genId: () => "ok" });
    const okJob = jobs.createJob({ kind: "build" });
    const { child: okChild, spawn: okSpawn } = fakeSpawn();
    spawnPhase(okJob, { args: ["build"], cwd: "/tmp/root" }, { jobs, spawn: okSpawn });
    okChild.emit("close", 0);
    expect(jobs.getJob("ok")!.status).toBe("succeeded");
    expect(jobs.getJob("ok")!.exitCode).toBe(0);

    const failJobs = new JobStore({ genId: () => "bad" });
    const badJob = failJobs.createJob({ kind: "build" });
    const { child: badChild, spawn: badSpawn } = fakeSpawn();
    spawnPhase(badJob, { args: ["build"], cwd: "/tmp/root" }, { jobs: failJobs, spawn: badSpawn });
    badChild.emit("close", 3);
    expect(failJobs.getJob("bad")!.status).toBe("failed");
    expect(failJobs.getJob("bad")!.exitCode).toBe(3);
  });

  it("registers a cancel() that SIGTERMs then SIGKILLs, and marks the job canceled", () => {
    vi.useFakeTimers();
    try {
      const jobs = new JobStore({ genId: () => "j1" });
      const job = jobs.createJob({ kind: "build" });
      const { child, spawn } = fakeSpawn();
      spawnPhase(job, { args: ["build"], cwd: "/tmp/root" }, { jobs, spawn });
      jobs.cancelJob("j1");
      expect(jobs.getJob("j1")!.status).toBe("canceled");
      expect(child.signals[0]).toBe("SIGTERM");
      vi.advanceTimersByTime(10_000);
      expect(child.signals).toContain("SIGKILL");
      // A late close must NOT flip the canceled job back to failed/succeeded.
      child.emit("close", 1);
      expect(jobs.getJob("j1")!.status).toBe("canceled");
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases the mutation lock exactly once on close (idempotent)", () => {
    const jobs = new JobStore({ genId: () => "j1" });
    const job = jobs.createJob({ kind: "build", root: "/tmp/root" });
    const { child, spawn } = fakeSpawn();
    const release = vi.fn();
    spawnPhase(job, { args: ["build"], cwd: "/tmp/root" }, { jobs, spawn, release });
    expect(release).not.toHaveBeenCalled();
    child.emit("close", 0);
    child.emit("close", 0); // a duplicate event must not double-release
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("releases the lock on a spawn error and marks the job failed", () => {
    const jobs = new JobStore({ genId: () => "j1" });
    const job = jobs.createJob({ kind: "build" });
    const { child, spawn } = fakeSpawn();
    const release = vi.fn();
    spawnPhase(job, { args: ["build"], cwd: "/tmp/root" }, { jobs, spawn, release });
    child.emit("error", new Error("ENOENT"));
    expect(jobs.getJob("j1")!.status).toBe("failed");
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe("TargetLock — per-target mutation lock", () => {
  it("admits one holder per target and reports the holder on contention", () => {
    const lock = new TargetLock();
    expect(lock.tryAcquire("/a", "job1")).toEqual({ ok: true });
    expect(lock.tryAcquire("/a", "job2")).toEqual({ ok: false, jobId: "job1" });
    expect(lock.holder("/a")).toBe("job1");
    // A DIFFERENT target is independent.
    expect(lock.tryAcquire("/b", "job3")).toEqual({ ok: true });
  });

  it("release frees the target so a later writer can acquire it", () => {
    const lock = new TargetLock();
    lock.tryAcquire("/a", "job1");
    lock.release("/a");
    expect(lock.holder("/a")).toBeUndefined();
    expect(lock.tryAcquire("/a", "job2")).toEqual({ ok: true });
  });

  it("release is idempotent and only affects the named target", () => {
    const lock = new TargetLock();
    lock.tryAcquire("/a", "job1");
    lock.tryAcquire("/b", "job2");
    lock.release("/a");
    lock.release("/a"); // no throw, no effect
    expect(lock.holder("/a")).toBeUndefined();
    expect(lock.holder("/b")).toBe("job2");
  });
});
