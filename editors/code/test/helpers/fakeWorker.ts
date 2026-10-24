import { EventEmitter } from "node:events";
import { createIndexHost } from "../../src/base/indexHost.ts";
import type { WorkerLike } from "../../src/base/indexClient.ts";
import type { RequestMessage } from "../../src/base/protocol.ts";
import { createFakeWasm, type FakeBehavior } from "./fakeIndex.ts";

export interface FakeWorker extends WorkerLike {
  received: RequestMessage[];
  terminated: boolean;
  behavior: FakeBehavior;
  /** Simulate the worker thread dying. */
  crash(code?: number): void;
  /** Stop answering, like an infinite loop in wasm. */
  hang(): void;
  emit(event: string, ...args: unknown[]): boolean;
}

/** An in-process worker backed by the real IndexHost and a fake index, answering asynchronously like a thread. */
export function createFakeWorker(): FakeWorker {
  const emitter = new EventEmitter();
  const { wasm, behavior } = createFakeWasm();
  const host = createIndexHost(wasm, (level, message) => emitter.emit("message", { event: "log", level, message }));
  let hanging = false;

  const worker: FakeWorker = {
    received: [],
    terminated: false,
    behavior,
    postMessage(message) {
      const request = message as RequestMessage;
      worker.received.push(request);
      if (hanging || worker.terminated) return;
      queueMicrotask(() => emitter.emit("message", host.handle(request)));
    },
    on: (event, listener) => emitter.on(event, listener),
    emit: (event, ...args) => emitter.emit(event, ...args),
    async terminate() {
      worker.terminated = true;
      return 0;
    },
    crash(code = 1) {
      worker.terminated = true;
      emitter.emit("exit", code);
    },
    hang() {
      hanging = true;
    },
  };
  return worker;
}
