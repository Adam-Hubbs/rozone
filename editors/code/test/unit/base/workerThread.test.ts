import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { createIndexClient, type IndexClient } from "../../../src/base/indexClient.ts";
import type { LogLevel } from "../../../src/base/types.ts";

const workerEntry = new URL("../../../src/base/worker.ts", import.meta.url);
const goodWasm = fileURLToPath(new URL("../../helpers/fakeWasmModule.ts", import.meta.url));

function start(wasmEntry: string) {
  const logs: [LogLevel, string][] = [];
  const workers: Worker[] = [];
  const client = createIndexClient({
    createWorker: () => {
      const worker = new Worker(workerEntry, { workerData: { wasmEntry } });
      workers.push(worker);
      return worker;
    },
    log: (level, message) => logs.push([level, message]),
    requestTimeoutMs: 5000,
  });
  return { client, logs, workers };
}

async function stop(client: IndexClient) {
  await client.dispose();
}

test("a real worker thread serves hover requests through the protocol", async () => {
  const { client } = start(goodWasm);
  try {
    await client.updateFiles([{ path: "/a.R", text: "f <- 1" }]);
    assert.equal((await client.hover("/a.R", 2))?.markdown, "hover@2");
    assert.equal(await client.contentHash("abc"), "hash:3");
    assert.equal(await client.hover("/other.R", 0), undefined);
  } finally {
    await stop(client);
  }
});

test("a panic inside the worker rejects that request and the worker keeps serving", async () => {
  const { client, workers, logs } = start(goodWasm);
  try {
    await client.updateFiles([{ path: "/good.R", text: "ok" }]);
    await assert.rejects(client.updateFiles([{ path: "/bad.R", text: "PANIC" }]), /unreachable/);
    assert.equal(workers.length, 1);
    assert.equal((await client.hover("/good.R", 1))?.markdown, "hover@1");
    assert.ok(logs.some(([level, message]) => level === "error" && message.includes("wasm panic")));
  } finally {
    await stop(client);
  }
});

test("when the worker thread is killed, the client restarts it and replays texts", async () => {
  const { client, workers } = start(goodWasm);
  try {
    await client.updateFiles([{ path: "/keep.R", text: "keep" }]);
    await workers[0]?.terminate();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(workers.length, 2);
    assert.equal((await client.hover("/keep.R", 1))?.markdown, "hover@1");
  } finally {
    await stop(client);
  }
});

test("a file that kills the thread on every replay ends in a failed state, not an endless loop", async () => {
  const { client, workers } = start(goodWasm);
  try {
    await assert.rejects(client.updateFiles([{ path: "/die.R", text: "EXIT" }]));
    for (let i = 0; i < 50 && client.state() === "running"; i++) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(client.state(), "failed");
    assert.ok(workers.length <= 6);
  } finally {
    await stop(client);
  }
});

test("a missing wasm module fails the client without a restart loop", async () => {
  const { client, workers, logs } = start("/definitely/not/here/rozone_wasm.js");
  try {
    await assert.rejects(client.hover("/a.R", 0));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(workers.length, 1);
    assert.equal(client.state(), "failed");
    assert.ok(logs.some(([level, message]) => level === "error" && message.includes("unavailable")));
  } finally {
    await stop(client);
  }
});
