import assert from "node:assert/strict";
import { test } from "node:test";
import { createCoalescer, type Timers } from "../../../src/base/coalescer.ts";

function manualTimers() {
  let next = 1;
  const scheduled = new Map<number, () => void>();
  const timers: Timers = {
    setTimeout(callback) {
      const handle = next++;
      scheduled.set(handle, callback);
      return handle;
    },
    clearTimeout(handle) {
      scheduled.delete(handle as number);
    },
  };
  const fire = () => {
    const callbacks = [...scheduled.values()];
    scheduled.clear();
    callbacks.forEach((callback) => callback());
  };
  return { timers, fire, pending: () => scheduled.size };
}

function setup() {
  const clock = manualTimers();
  const batches: [string, string][][] = [];
  const coalescer = createCoalescer<string, string>((entries) => batches.push(entries), 10, clock.timers);
  return { clock, batches, coalescer };
}

test("keeps only the latest value per key and flushes one batch", () => {
  const { coalescer, clock, batches } = setup();
  coalescer.set("a", "1");
  coalescer.set("a", "2");
  coalescer.set("b", "x");
  coalescer.set("a", "3");
  assert.equal(batches.length, 0);
  clock.fire();
  assert.deepEqual(batches, [[["a", "3"], ["b", "x"]]]);
});

test("schedules a single timer for a burst", () => {
  const { coalescer, clock } = setup();
  coalescer.set("a", "1");
  coalescer.set("b", "2");
  coalescer.set("a", "3");
  assert.equal(clock.pending(), 1);
});

test("flushKey sends only that key immediately and keeps the timer for the rest", () => {
  const { coalescer, clock, batches } = setup();
  coalescer.set("a", "1");
  coalescer.set("b", "2");
  coalescer.flushKey("a");
  assert.deepEqual(batches, [[["a", "1"]]]);
  assert.equal(coalescer.has("a"), false);
  assert.equal(coalescer.has("b"), true);
  assert.equal(clock.pending(), 1);
  clock.fire();
  assert.deepEqual(batches[1], [["b", "2"]]);
});

test("flushKey of the last pending key cancels the timer", () => {
  const { coalescer, clock, batches } = setup();
  coalescer.set("a", "1");
  coalescer.flushKey("a");
  assert.equal(clock.pending(), 0);
  clock.fire();
  assert.equal(batches.length, 1);
});

test("flushKey on an unknown key does nothing", () => {
  const { coalescer, batches } = setup();
  coalescer.flushKey("zzz");
  assert.equal(batches.length, 0);
});

test("a value set after a flush starts a new batch with a new timer", () => {
  const { coalescer, clock, batches } = setup();
  coalescer.set("a", "1");
  clock.fire();
  coalescer.set("a", "2");
  assert.equal(clock.pending(), 1);
  clock.fire();
  assert.deepEqual(batches, [[["a", "1"]], [["a", "2"]]]);
});

test("delete drops a pending value", () => {
  const { coalescer, clock, batches } = setup();
  coalescer.set("a", "1");
  coalescer.set("b", "2");
  coalescer.delete("a");
  clock.fire();
  assert.deepEqual(batches, [[["b", "2"]]]);
});

test("flushAll with nothing pending is silent", () => {
  const { coalescer, batches } = setup();
  coalescer.flushAll();
  assert.equal(batches.length, 0);
});

test("dispose discards pending work and cancels the timer", () => {
  const { coalescer, clock, batches } = setup();
  coalescer.set("a", "1");
  coalescer.dispose();
  assert.equal(clock.pending(), 0);
  clock.fire();
  assert.equal(batches.length, 0);
});

test("works with the real timers", async () => {
  const batches: [string, number][][] = [];
  const coalescer = createCoalescer<string, number>((entries) => batches.push(entries), 5);
  coalescer.set("a", 1);
  coalescer.set("a", 2);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(batches, [[["a", 2]]]);
});
