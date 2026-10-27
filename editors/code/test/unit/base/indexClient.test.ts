import assert from "node:assert/strict";
import { test } from "node:test";
import { createIndexClient, IndexError, type IndexClientOptions } from "../../../src/base/indexClient.ts";
import type { LogLevel } from "../../../src/base/types.ts";
import { createFakeWorker, type FakeWorker } from "../../helpers/fakeWorker.ts";

function setup(overrides: Partial<IndexClientOptions> = {}) {
  const workers: FakeWorker[] = [];
  const logs: [LogLevel, string][] = [];
  const client = createIndexClient({
    createWorker: () => {
      const worker = createFakeWorker();
      workers.push(worker);
      return worker;
    },
    log: (level, message) => logs.push([level, message]),
    ...overrides,
  });
  const current = () => workers.at(-1) as FakeWorker;
  return { client, workers, logs, current };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("round-trips a hover through the worker", async () => {
  const { client } = setup();
  await client.updateFiles([{ path: "/a.R", text: "f <- 1" }]);
  const hover = await client.hover("/a.R", 4);
  assert.equal(hover?.markdown, "hover@4");
  assert.equal(await client.hover("/nope.R", 0), undefined);
});

test("requests reach the worker in call order", async () => {
  const { client, current } = setup();
  const pending = [
    client.updateFiles([{ path: "/a.R", text: "1" }]),
    client.updateFiles([{ path: "/a.R", text: "2" }]),
    client.hover("/a.R", 0),
    client.removeFiles(["/a.R"]),
  ];
  await Promise.all(pending);
  const received = current().received;
  assert.deepEqual(received.map((r) => r.method), ["updateFiles", "updateFiles", "hover", "removeFiles"]);
});

test("concurrent responses are matched to the right caller", async () => {
  const { client } = setup();
  await client.updateFiles([{ path: "/a.R", text: "x" }]);
  const [one, two, hash] = await Promise.all([client.hover("/a.R", 1), client.hover("/a.R", 2), client.contentHash("abcd")]);
  assert.equal(one?.markdown, "hover@1");
  assert.equal(two?.markdown, "hover@2");
  assert.equal(hash, "hash:4");
});

test("errors from the worker reject with IndexError and keep the panic flag", async () => {
  const { client, current } = setup();
  await client.updateFiles([{ path: "/a.R", text: "x" }]);
  current().behavior.hoverPanicsFor = "/a.R";
  await assert.rejects(client.hover("/a.R", 0), (error: unknown) => {
    assert.ok(error instanceof IndexError);
    assert.equal(error.panic, true);
    return true;
  });
  current().behavior.hoverPanicsFor = undefined;
  assert.equal((await client.hover("/a.R", 2))?.markdown, "hover@2");
  assert.equal(client.state(), "running");
});

test("a bad manifest rejects without touching the worker", async () => {
  const { client, workers } = setup();
  await assert.rejects(client.loadManifest("nope"), /JSON|Unexpected/);
  assert.equal(workers.length, 1);
});

test("worker log events are forwarded with a prefix", async () => {
  const { client, logs, current } = setup();
  await client.updateFiles([{ path: "/a.R", text: "x" }]);
  current().behavior.hoverPanicsFor = "/a.R";
  await client.hover("/a.R", 0).catch(() => {});
  assert.ok(logs.some(([level, message]) => level === "error" && message.startsWith("[worker] wasm panic in hover")));
});

test("when the worker dies it restarts and replays the last known texts and manifest", async () => {
  const { client, workers, current, logs } = setup();
  await client.updateFiles([
    { path: "/a.R", text: "old" },
    { path: "/b.R", text: "b" },
  ]);
  await client.updateFiles([{ path: "/a.R", text: "new" }]);
  await client.removeFiles(["/b.R"]);
  const manifest = JSON.stringify({ version: 1, files: [] });
  await client.loadManifest(manifest);

  current().crash(7);
  await settle();

  assert.equal(workers.length, 2);
  assert.equal(client.state(), "running");
  const replacement = workers[1] as FakeWorker;
  const hover = await client.hover("/a.R", 1);
  assert.equal(hover?.markdown, "hover@1");
  const index = replacement.behavior.instances[0];
  assert.deepEqual([...(index?.files ?? [])], [["/a.R", "new"]]);
  assert.equal(index?.manifest, manifest);
  assert.ok(logs.some(([level, message]) => level === "error" && message.includes("exit code 7")));
});

test("requests in flight when the worker dies are rejected, later ones succeed", async () => {
  const { client, current } = setup();
  await client.updateFiles([{ path: "/a.R", text: "x" }]);
  current().hang();
  const inFlight = client.hover("/a.R", 0);
  current().crash();
  await assert.rejects(inFlight, /index worker stopped/);
  assert.equal((await client.hover("/a.R", 3))?.markdown, "hover@3");
});

test("an error event restarts the worker too, and stale workers are ignored", async () => {
  const { client, workers } = setup();
  const first = workers[0] as FakeWorker;
  first.emit("error", new Error("boom"));
  first.emit("exit", 1);
  await settle();
  assert.equal(workers.length, 2, "error then exit of the same worker restarts once");
  assert.equal(client.state(), "running");
});

test("a request that never completes times out, rejects, and restarts the worker", async () => {
  const { client, current, workers } = setup({ requestTimeoutMs: 20 });
  await client.updateFiles([{ path: "/a.R", text: "x" }]);
  current().hang();
  await assert.rejects(client.hover("/a.R", 0), /timed out/);
  await settle();
  assert.equal(workers.length, 2);
  assert.equal(workers[0]?.terminated, true);
  assert.equal((await client.hover("/a.R", 1))?.markdown, "hover@1");
});

test("gives up after too many crashes and rejects cleanly instead of looping", async () => {
  const { client, workers, current, logs } = setup({ maxRestarts: 2 });
  for (let i = 0; i < 3; i++) {
    current().crash();
    await settle();
  }
  assert.equal(client.state(), "failed");
  assert.equal(workers.length, 3);
  await assert.rejects(client.hover("/a.R", 0), /unavailable|failed/);
  assert.ok(logs.some(([, message]) => message.includes("index unavailable")));
});

test("crashes outside the restart window do not count against the budget", async () => {
  const { client, workers, current } = setup({ maxRestarts: 1, restartWindowMs: 5 });
  current().crash();
  await settle();
  await new Promise((resolve) => setTimeout(resolve, 15));
  current().crash();
  await settle();
  assert.equal(client.state(), "running");
  assert.equal(workers.length, 3);
});

test("a fatal wasm load failure fails the client without restarting", async () => {
  const { client, workers, current } = setup();
  current().emit("message", { event: "fatal", message: "cannot find rozone_wasm.js" });
  assert.equal(client.state(), "failed");
  current().crash();
  await settle();
  assert.equal(workers.length, 1);
  await assert.rejects(client.contentHash("x"), /unavailable|failed/);
});

test("dispose terminates the worker, rejects pending work and ignores the exit event", async () => {
  const { client, workers, current } = setup();
  current().hang();
  const inFlight = client.hover("/a.R", 0);
  await client.dispose();
  await assert.rejects(inFlight, /disposed/);
  assert.equal(workers[0]?.terminated, true);
  workers[0]?.emit("exit", 0);
  await settle();
  assert.equal(workers.length, 1);
  assert.equal(client.state(), "disposed");
  await assert.rejects(client.hover("/a.R", 0), /disposed/);
  await client.dispose();
});

test("large replays are chunked", async () => {
  const { client, workers, current } = setup();
  const files = Array.from({ length: 450 }, (_, i) => ({ path: `/f${i}.R`, text: String(i) }));
  await client.updateFiles(files);
  current().crash();
  await settle();
  const replayed = (workers[1] as FakeWorker).received.filter((r) => r.method === "updateFiles");
  assert.deepEqual(
    replayed.map((r) => (r.method === "updateFiles" ? r.params.files.length : 0)),
    [200, 200, 50],
  );
});
