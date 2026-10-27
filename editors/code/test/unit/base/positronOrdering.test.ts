import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createReregistrar,
  reregisterOnPositronEvents,
  type DisposableLike,
  type PositronLike,
  type SessionLike,
} from "../../../src/base/positronOrdering.ts";

function emitter<T>() {
  const listeners = new Set<(value: T) => void>();
  return {
    event: (listener: (value: T) => void): DisposableLike => {
      listeners.add(listener);
      return { dispose: () => void listeners.delete(listener) };
    },
    fire: (value: T) => listeners.forEach((listener) => listener(value)),
    count: () => listeners.size,
  };
}

function manualClock() {
  let next = 1;
  const queue = new Map<number, { callback: () => void; ms: number }>();
  return {
    setTimeout: (callback: () => void, ms: number) => {
      const handle = next++;
      queue.set(handle, { callback, ms });
      return handle;
    },
    clearTimeout: (handle: unknown) => void queue.delete(handle as number),
    pending: () => [...queue.values()].map((entry) => entry.ms),
    flush: () => {
      const entries = [...queue.values()];
      queue.clear();
      entries.forEach((entry) => entry.callback());
    },
  };
}

function setup(sessions: SessionLike[] = []) {
  const foreground = emitter<string | undefined>();
  const registered = emitter<unknown>();
  let sessionLookups = 0;
  const positron: PositronLike = {
    runtime: {
      onDidChangeForegroundSession: foreground.event,
      onDidRegisterRuntime: registered.event,
      getActiveSessions: async () => {
        sessionLookups++;
        return sessions;
      },
    },
  };
  const registrations: { disposed: boolean }[] = [];
  const reregistrar = createReregistrar(() => {
    const registration = { disposed: false };
    registrations.push(registration);
    return { dispose: () => void (registration.disposed = true) };
  });
  const clock = manualClock();
  const subscription = reregisterOnPositronEvents(positron, reregistrar, { delaysMs: [10, 100], ...clock });
  return { foreground, registered, registrations, reregistrar, clock, subscription, lookups: () => sessionLookups };
}

const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

test("reregistrar registers once up front and swaps registrations, disposing the old one", () => {
  const registrations: { disposed: boolean }[] = [];
  const reregistrar = createReregistrar(() => {
    const registration = { disposed: false };
    registrations.push(registration);
    return { dispose: () => void (registration.disposed = true) };
  });
  assert.equal(registrations.length, 1);
  reregistrar.reregister();
  assert.equal(registrations.length, 2);
  assert.deepEqual(registrations.map((r) => r.disposed), [true, false]);
  reregistrar.dispose();
  assert.deepEqual(registrations.map((r) => r.disposed), [true, true]);
  reregistrar.reregister();
  assert.equal(registrations.length, 2, "no registrations after dispose");
});

test("the new registration exists before the old one is disposed", () => {
  const order: string[] = [];
  let n = 0;
  const reregistrar = createReregistrar(() => {
    const id = ++n;
    order.push(`register ${id}`);
    return { dispose: () => void order.push(`dispose ${id}`) };
  });
  reregistrar.reregister();
  assert.deepEqual(order, ["register 1", "register 2", "dispose 1"]);
});

test("a foreground session change re-registers at each configured delay", () => {
  const { foreground, registrations, clock } = setup();
  foreground.fire("session-1");
  assert.deepEqual(clock.pending(), [10, 100]);
  assert.equal(registrations.length, 1);
  clock.flush();
  assert.equal(registrations.length, 3);
});

test("ready and restarting runtime states re-register; busy and idle do not", async () => {
  const state = emitter<string>();
  const { clock, registrations } = setup([{ onDidChangeRuntimeState: state.event }]);
  await flushMicrotasks();
  for (const ignored of ["starting", "idle", "busy", "exited"]) state.fire(ignored);
  assert.deepEqual(clock.pending(), []);
  state.fire("ready");
  assert.deepEqual(clock.pending(), [10, 100]);
  clock.flush();
  state.fire("restarting");
  clock.flush();
  assert.equal(registrations.length, 5);
});

test("a session is watched once even if it is listed again", async () => {
  const state = emitter<string>();
  const session: SessionLike = { onDidChangeRuntimeState: state.event };
  const { foreground } = setup([session]);
  await flushMicrotasks();
  foreground.fire("a");
  await flushMicrotasks();
  foreground.fire("b");
  await flushMicrotasks();
  assert.equal(state.count(), 1);
});

test("sessions without a state event are tolerated", async () => {
  const { foreground, clock } = setup([{}]);
  await flushMicrotasks();
  foreground.fire(undefined);
  assert.equal(clock.pending().length, 2);
});

test("registering a runtime refreshes the watched sessions without re-registering", async () => {
  const { registered, lookups, clock } = setup();
  await flushMicrotasks();
  const before = lookups();
  registered.fire({});
  await flushMicrotasks();
  assert.equal(lookups(), before + 1);
  assert.deepEqual(clock.pending(), []);
});

test("a failing session lookup is swallowed", async () => {
  const foreground = emitter<string | undefined>();
  const positron: PositronLike = {
    runtime: {
      onDidChangeForegroundSession: foreground.event,
      onDidRegisterRuntime: emitter<unknown>().event,
      getActiveSessions: () => Promise.reject(new Error("no sessions")),
    },
  };
  const reregistrar = createReregistrar(() => ({ dispose() {} }));
  assert.doesNotThrow(() => reregisterOnPositronEvents(positron, reregistrar));
  await flushMicrotasks();
});

test("dispose cancels pending re-registrations and unsubscribes everything", async () => {
  const state = emitter<string>();
  const { foreground, registered, subscription, clock, registrations } = setup([{ onDidChangeRuntimeState: state.event }]);
  await flushMicrotasks();
  foreground.fire("x");
  subscription.dispose();
  assert.deepEqual(clock.pending(), []);
  assert.equal(foreground.count(), 0);
  assert.equal(registered.count(), 0);
  assert.equal(state.count(), 0);
  clock.flush();
  assert.equal(registrations.length, 1);
});
