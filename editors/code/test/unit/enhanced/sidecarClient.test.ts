import assert from "node:assert/strict";
import cpDefault from "node:child_process";
import type * as cp from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { fileURLToPath } from "node:url";
import { defaultSpawn, SidecarClient, SidecarError } from "../../../src/enhanced/sidecarClient.ts";
import type { ExitInfo, SpawnFn } from "../../../src/enhanced/sidecarClient.ts";

const fakeScript = fileURLToPath(new URL("../../fixtures/fake-sidecar/fake-sidecar.ts", import.meta.url));

let dir: string;
let recordFile: string;
const clients: SidecarClient[] = [];
const logs: string[] = [];
const log = {
  info: (m: string) => logs.push(`info ${m}`),
  warn: (m: string) => logs.push(`warn ${m}`),
  error: (m: string) => logs.push(`error ${m}`),
};

function makeClient(mode: string, extra: Record<string, string> = {}, opts: Partial<ConstructorParameters<typeof SidecarClient>[0]> = {}) {
  const client = new SidecarClient({
    command: process.execPath,
    args: [fakeScript],
    env: { ...process.env, FAKE_MODE: mode, FAKE_RECORD: recordFile, ...extra },
    log,
    ...opts,
  });
  clients.push(client);
  return client;
}

const recorded = () =>
  readFileSync(recordFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

const waitForExit = (client: SidecarClient) =>
  new Promise<ExitInfo>((resolve) => {
    client.onExit(resolve);
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rozone-client-"));
  recordFile = join(dir, "record.jsonl");
  logs.length = 0;
});

afterEach(() => {
  for (const c of clients.splice(0)) c.kill();
  rmSync(dir, { recursive: true, force: true });
});

describe("handshake", () => {
  it("resolves with the hello", async () => {
    const hello = await makeClient("normal").start();
    assert.equal(hello.ok, true);
    assert.equal(hello.r_version, "4.6.1");
    assert.deepEqual(hello.missing, []);
  });

  it("reports missing roxygen2 and the process exits with status 3", async () => {
    const client = makeClient("missing-roxygen2");
    const exit = waitForExit(client);
    const hello = await client.start();
    assert.equal(hello.ok, false);
    assert.deepEqual(hello.missing, ["roxygen2"]);
    const info = await exit;
    assert.equal(info.code, 3);
    assert.equal(info.intentional, false);
  });

  it("rejects with a timeout when no hello arrives, and kills the process", async () => {
    const client = makeClient("hang-hello", {}, { helloTimeoutMs: 150 });
    const exit = waitForExit(client);
    await assert.rejects(client.start(), (e: unknown) => e instanceof SidecarError && e.code === "timeout");
    assert.equal((await exit).intentional, true);
    assert.equal(client.running, false);
  });

  it("rejects when the process exits before hello", async () => {
    await assert.rejects(makeClient("crash-on-start").start(), (e: unknown) => e instanceof SidecarError && e.code === "exit");
  });

  it("rejects with a spawn error for a missing binary", async () => {
    const client = new SidecarClient({ command: join(dir, "does-not-exist"), args: [], env: {}, log });
    await assert.rejects(client.start(), (e: unknown) => e instanceof SidecarError && e.code === "spawn");
  });

  it("rejects when the spawn function throws", async () => {
    const spawn: SpawnFn = () => {
      throw new Error("EACCES");
    };
    const client = new SidecarClient({ command: "x", args: [], env: {}, log, spawn });
    await assert.rejects(client.start(), /EACCES/);
  });

  it("tolerates garbage lines, CRLF and split writes", async () => {
    for (const mode of ["garbage", "crlf", "split", "garbage,crlf,split"]) {
      const client = makeClient(mode);
      assert.equal((await client.start()).ok, true, mode);
      assert.deepEqual(await client.request("ping"), { pong: true }, mode);
      client.kill();
    }
    assert.ok(logs.some((l) => l.startsWith("warn ignoring non-JSON")));
  });
});

describe("requests", () => {
  it("passes the spawn options through (args, env, cwd)", async () => {
    const client = makeClient("normal", { R_LIBS: "/a:/b" }, { cwd: dir });
    await client.start();
    const start = recorded()[0] as { argv: string[]; R_LIBS: string; cwd: string };
    assert.equal(start.R_LIBS, "/a:/b");
    assert.ok(start.cwd.endsWith(dir.split("/").at(-1) ?? ""));
  });

  it("matches concurrent responses to their requests by id, in order", async () => {
    const client = makeClient("slow", { FAKE_DELAY_MS: "20" });
    await client.start();
    const results = await Promise.all(
      [1, 2, 3, 4].map((n) =>
        client.request<{ topics: string[] }>("build", { files: [{ path: `/w/f${n}.R`, hash: "h" }] }),
      ),
    );
    assert.deepEqual(results.map((r) => r.topics[0]), ["fn_f1", "fn_f2", "fn_f3", "fn_f4"]);
    const ids = recorded().flatMap((r) => (r["request"] ? [(r["request"] as { id: number }).id] : []));
    assert.deepEqual(ids, [1, 2, 3, 4]);
  });

  it("surfaces sidecar errors as remote SidecarErrors without breaking the client", async () => {
    const client = makeClient("normal");
    await client.start();
    await assert.rejects(client.request("fail"), (e: unknown) => e instanceof SidecarError && e.code === "remote" && /requested failure/.test(e.message));
    assert.deepEqual(await client.request("ping"), { pong: true });
  });

  it("times out an individual request and ignores the late reply", async () => {
    const client = makeClient("slow", { FAKE_DELAY_MS: "300" });
    await client.start();
    await assert.rejects(client.request("ping", {}, 50), (e: unknown) => e instanceof SidecarError && e.code === "timeout");
    assert.deepEqual(await client.request("ping", {}, 2000), { pong: true });
    assert.ok(logs.some((l) => /unknown request id/.test(l)));
  });

  it("rejects requests on a client that is not running", async () => {
    const client = makeClient("normal");
    await assert.rejects(client.request("ping"), (e: unknown) => e instanceof SidecarError && e.code === "closed");
  });

  it("forwards stderr to the log", async () => {
    const client = makeClient("stderr");
    await client.start();
    await client.request("ping");
    assert.ok(logs.some((l) => l.includes("[sidecar] handling ping")));
  });
});

describe("crashes", () => {
  it("rejects pending requests and reports a non-intentional exit", async () => {
    const client = makeClient("crash-after", { FAKE_CRASH_AFTER: "1" });
    const exit = waitForExit(client);
    await client.start();
    assert.deepEqual(await client.request("ping"), { pong: true });
    // The fake exits after answering; the next request races with that exit.
    const after = await Promise.allSettled([client.request("ping"), client.request("ping")]);
    assert.ok(after.every((r) => r.status === "rejected"));
    const info = await exit;
    assert.equal(info.code, 1);
    assert.equal(info.intentional, false);
    assert.equal(client.running, false);
  });

  it("rejects an in-flight request when the process dies", async () => {
    const client = makeClient("slow,crash-after", { FAKE_DELAY_MS: "10", FAKE_CRASH_AFTER: "1" });
    await client.start();
    const results = await Promise.allSettled([client.request("ping"), client.request("ping"), client.request("ping")]);
    assert.equal(results[0]?.status, "fulfilled");
    assert.ok(results.slice(1).every((r) => r.status === "rejected" && r.reason instanceof SidecarError));
  });
});

describe("shutdown", () => {
  it("exits gracefully and reports an intentional exit", async () => {
    const client = makeClient("normal");
    const exit = waitForExit(client);
    await client.start();
    await client.shutdown();
    const info = await exit;
    assert.equal(info.intentional, true);
    assert.equal(info.code, 0);
  });

  it("kills the process when it ignores shutdown", async () => {
    const client = makeClient("hang", {}, { shutdownGraceMs: 100 });
    const exit = waitForExit(client);
    await client.start();
    await client.shutdown();
    const info = await exit;
    assert.equal(info.signal, "SIGKILL");
    assert.equal(info.intentional, true);
    assert.ok(logs.some((l) => /killing it/.test(l)));
  });

  it("is a no-op when nothing is running", async () => {
    await makeClient("normal").shutdown();
  });

  it("kill() is idempotent", async () => {
    const client = makeClient("normal");
    await client.start();
    client.kill();
    client.kill();
    assert.equal(client.running, false);
  });
});

describe("spawn function", () => {
  it("defaultSpawn goes through cp.spawn looked up at call time", () => {
    const stub = mock.method(cpDefault, "spawn", () => ({}) as cp.ChildProcess);
    syncBuiltinESMExports();
    try {
      defaultSpawn("Rscript", ["a.R"], { env: { X: "1" }, cwd: "/w" });
      assert.equal(stub.mock.callCount(), 1);
      const [command, args, options] = stub.mock.calls[0]?.arguments as unknown as [string, string[], cp.SpawnOptions];
      assert.equal(command, "Rscript");
      assert.deepEqual(args, ["a.R"]);
      assert.equal(options.cwd, "/w");
    } finally {
      stub.mock.restore();
      syncBuiltinESMExports();
    }
  });

  it("works with an in-memory child and a hello split into byte-sized chunks", async () => {
    const stdout = new PassThrough();
    const stdin = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdout, stdin, stderr: new PassThrough(), kill: () => true });
    const client = new SidecarClient({ command: "x", args: [], env: {}, log, spawn: () => child as unknown as cp.ChildProcess });
    const started = client.start();
    for (const ch of '{"event":"hello","protocol":1,"missing":[""],"ok":true}\r\n') stdout.write(ch);
    const hello = await started;
    assert.equal(hello.ok, true);
    assert.deepEqual(hello.missing, []);
    const pending = client.request("ping");
    stdout.write('{"id":1,"result":{"pong":true}}\n{"id":99,"result":{}}\n');
    assert.deepEqual(await pending, { pong: true });
    child.emit("close", 0, null);
    assert.equal(client.running, false);
  });
});
