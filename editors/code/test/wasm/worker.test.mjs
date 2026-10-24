import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { Worker } from "node:worker_threads";

import { fnv1a64, wasmModulePath } from "./helpers.mjs";

const workerSource = `
const { parentPort, workerData } = require("node:worker_threads");
const { contentHash } = require(workerData.modulePath);
parentPort.postMessage(contentHash(workerData.text));
`;

test("WASM loads inside a worker_threads Worker and round-trips contentHash", async () => {
  const text = "héllo wörld 🎉";
  const worker = new Worker(workerSource, {
    eval: true,
    workerData: { modulePath: wasmModulePath, text },
  });
  const [hash] = await once(worker, "message");
  await once(worker, "exit");
  assert.equal(hash, fnv1a64(text));
});
