export interface Coalescer<K, V> {
  set(key: K, value: V): void;
  has(key: K): boolean;
  /** Flush one key now, if pending. Providers call this so queries never see stale text. */
  flushKey(key: K): void;
  flushAll(): void;
  delete(key: K): void;
  dispose(): void;
}

export interface Timers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: Timers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Keeps only the latest value per key and hands pending entries over in one batch. */
export function createCoalescer<K, V>(
  flush: (entries: [K, V][]) => void,
  delayMs = 15,
  timers: Timers = realTimers,
): Coalescer<K, V> {
  const latest = new Map<K, V>();
  let handle: unknown;

  const run = () => {
    handle = undefined;
    flushAll();
  };

  const flushAll = () => {
    if (handle !== undefined) {
      timers.clearTimeout(handle);
      handle = undefined;
    }
    if (latest.size === 0) return;
    const entries = [...latest];
    latest.clear();
    flush(entries);
  };

  return {
    set(key, value) {
      latest.set(key, value);
      handle ??= timers.setTimeout(run, delayMs);
    },
    has: (key) => latest.has(key),
    flushKey(key) {
      if (!latest.has(key)) return;
      const value = latest.get(key) as V;
      latest.delete(key);
      if (latest.size === 0 && handle !== undefined) {
        timers.clearTimeout(handle);
        handle = undefined;
      }
      flush([[key, value]]);
    },
    flushAll,
    delete(key) {
      latest.delete(key);
    },
    dispose() {
      if (handle !== undefined) timers.clearTimeout(handle);
      handle = undefined;
      latest.clear();
    },
  };
}
