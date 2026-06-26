/** A promise that resolves after `ms`, or early if the signal aborts. The single
 *  timer primitive in the harness — kept tiny and injectable so the build loop's
 *  auto-restart wait can be faked in tests without real time passing. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    const onAbort = () => done();
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
