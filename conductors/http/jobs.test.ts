import { describe, expect, it, vi } from "vitest";

import { JobStore } from "./jobs.ts";

function fixedClock(start = 1000): () => number {
  let t = start;
  return () => t++;
}

let idCounter = 0;
function seqIds(): () => string {
  idCounter = 0;
  return () => `job-${idCounter++}`;
}

describe("JobStore lifecycle", () => {
  it("createJob starts running with injected clock + id", () => {
    const store = new JobStore({ now: fixedClock(5000), genId: seqIds() });
    const job = store.createJob({ kind: "build", root: "/r" });
    expect(job.id).toBe("job-0");
    expect(job.kind).toBe("build");
    expect(job.root).toBe("/r");
    expect(job.status).toBe("running");
    expect(job.log).toBe("");
    expect(job.createdAt).toBe(5000);
    expect(store.getJob("job-0")).toBe(job);
  });

  it("appendLog accumulates; listJobs returns all in insertion order", () => {
    const store = new JobStore({ genId: seqIds() });
    store.createJob({ kind: "a" });
    store.createJob({ kind: "b" });
    store.appendLog("job-0", "hello ");
    store.appendLog("job-0", "world");
    expect(store.getJob("job-0")!.log).toBe("hello world");
    expect(store.listJobs().map((j) => j.id)).toEqual(["job-0", "job-1"]);
  });

  it("finish sets succeeded/failed + exitCode", () => {
    const store = new JobStore({ genId: seqIds() });
    store.createJob({ kind: "a" });
    store.createJob({ kind: "b" });
    store.finish("job-0", { status: "succeeded", exitCode: 0 });
    store.finish("job-1", { status: "failed", exitCode: 2 });
    expect(store.getJob("job-0")!.status).toBe("succeeded");
    expect(store.getJob("job-0")!.exitCode).toBe(0);
    expect(store.getJob("job-1")!.status).toBe("failed");
    expect(store.getJob("job-1")!.exitCode).toBe(2);
  });

  it("cancelJob invokes the registered callback and marks canceled", () => {
    const store = new JobStore({ genId: seqIds() });
    store.createJob({ kind: "a" });
    const cancel = vi.fn();
    store.registerCancel("job-0", cancel);
    const job = store.cancelJob("job-0");
    expect(cancel).toHaveBeenCalledOnce();
    expect(job!.status).toBe("canceled");
    expect(store.getJob("job-0")!.status).toBe("canceled");
  });

  it("cancelJob marks canceled even with no callback, and survives a throwing callback", () => {
    const store = new JobStore({ genId: seqIds() });
    store.createJob({ kind: "a" });
    store.createJob({ kind: "b" });
    expect(store.cancelJob("job-0")!.status).toBe("canceled");
    store.registerCancel("job-1", () => {
      throw new Error("kill failed");
    });
    expect(store.cancelJob("job-1")!.status).toBe("canceled");
  });

  it("returns undefined for unknown ids", () => {
    const store = new JobStore();
    expect(store.getJob("nope")).toBeUndefined();
    expect(store.cancelJob("nope")).toBeUndefined();
  });
});

describe("JobStore bounded retention", () => {
  it("keeps only the newest N, evicting oldest by insertion order", () => {
    const store = new JobStore({ lastNJobs: 3, genId: seqIds() });
    for (let i = 0; i < 5; i++) store.createJob({ kind: "k" });
    // job-0 and job-1 evicted; job-2..4 retained.
    expect(store.listJobs().map((j) => j.id)).toEqual(["job-2", "job-3", "job-4"]);
    expect(store.getJob("job-0")).toBeUndefined();
    expect(store.getJob("job-1")).toBeUndefined();
    expect(store.getJob("job-4")).toBeDefined();
  });
});
