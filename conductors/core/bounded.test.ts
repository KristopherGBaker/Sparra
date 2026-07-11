import { describe, expect, it } from "vitest";

import { mapBounded } from "./bounded.ts";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("mapBounded (generic bounded-concurrency pump)", () => {
  it("bounds concurrency: peak == bound when items > bound (asserted via onState)", async () => {
    let observedPeak = 0;
    const items = Array.from({ length: 7 }, (_, i) => i);
    const results = await mapBounded(
      items,
      async (item) => {
        await delay(15);
        return item * 2;
      },
      { concurrency: 3, onState: (s) => (observedPeak = Math.max(observedPeak, s.active)) },
    );
    expect(results).toHaveLength(7);
    expect(results.peakConcurrency).toBe(3);
    expect(observedPeak).toBe(3);
  });

  it("preserves input order regardless of completion order (later items resolve faster)", async () => {
    // Item 0 is slowest, later items are progressively faster — completion order is reversed
    // relative to input order, but the RESULT array must still be input-ordered.
    const items = [0, 1, 2, 3, 4];
    const results = await mapBounded(
      items,
      async (item) => {
        await delay((items.length - item) * 10);
        return `done-${item}`;
      },
      { concurrency: 5 },
    );
    expect(results).toEqual(["done-0", "done-1", "done-2", "done-3", "done-4"]);
  });

  it("all items complete: excess items queue, none are dropped", async () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    const results = await mapBounded(items, async (item) => item, { concurrency: 2 });
    expect(results).toHaveLength(10);
    expect([...results]).toEqual(items);
  });

  it("a worker that catches its own rejection resolves to the caller's error-shaped value — mapBounded itself never rejects the batch", async () => {
    const items = ["ok1", "bad", "ok2"];
    const results = await mapBounded(
      items,
      async (item) => {
        if (item === "bad") {
          try {
            await Promise.reject(new Error("boom"));
            return { item, ok: true as const };
          } catch (err) {
            return { item, ok: false as const, error: err instanceof Error ? err.message : String(err) };
          }
        }
        return { item, ok: true as const };
      },
      { concurrency: 2 },
    );
    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ item: "ok1", ok: true });
    expect(results[1]).toEqual({ item: "bad", ok: false, error: "boom" });
    expect(results[2]).toEqual({ item: "ok2", ok: true });
  });

  it("a worker that rejects UNCAUGHT fails the whole batch (mapBounded itself rejects, mirroring Promise.all)", async () => {
    const items = ["ok1", "bad", "ok2"];
    await expect(
      mapBounded(
        items,
        async (item) => {
          if (item === "bad") throw new Error("uncaught boom");
          await delay(5);
          return item;
        },
        { concurrency: 2 },
      ),
    ).rejects.toThrow("uncaught boom");
  });

  it("empty items resolves to [] with peakConcurrency 0", async () => {
    const results = await mapBounded([], async (item: never) => item, { concurrency: 3 });
    expect(results).toHaveLength(0);
    expect(results.peakConcurrency).toBe(0);
  });

  it("defaults concurrency to 3 when unspecified", async () => {
    let observedPeak = 0;
    const items = Array.from({ length: 6 }, (_, i) => i);
    await mapBounded(
      items,
      async (item) => {
        await delay(10);
        return item;
      },
      { onState: (s) => (observedPeak = Math.max(observedPeak, s.active)) },
    );
    expect(observedPeak).toBe(3);
  });
});
