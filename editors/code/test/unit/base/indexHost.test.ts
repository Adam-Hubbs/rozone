import assert from "node:assert/strict";
import { test } from "node:test";
import { createIndexHost, isPanic } from "../../../src/base/indexHost.ts";
import type { RequestMessage, ResponseMessage } from "../../../src/base/protocol.ts";
import type { LogLevel } from "../../../src/base/types.ts";
import { createFakeWasm } from "../../helpers/fakeIndex.ts";

function setup() {
  const { wasm, behavior } = createFakeWasm();
  const logs: [LogLevel, string][] = [];
  const host = createIndexHost(wasm, (level, message) => logs.push([level, message]));
  let id = 0;
  const call = <T extends Omit<RequestMessage, "id">>(request: T): ResponseMessage =>
    host.handle({ ...request, id: ++id } as RequestMessage);
  return { host, behavior, logs, call };
}

const update = (path: string, text: string) => ({ method: "updateFiles", params: { files: [{ path, text }] } }) as const;

test("answers queries from the index and echoes the request id", () => {
  const { call } = setup();
  call(update("/a.R", "f <- function() 1"));
  const response = call({ method: "hover", params: { path: "/a.R", offset: 3 } });
  assert.equal(response.ok, true);
  assert.equal(response.id, 1 + 1);
  assert.deepEqual(response.ok && (response.result as { markdown: string }).markdown, "hover@3");
});

test("turns null results into undefined", () => {
  const { call } = setup();
  const response = call({ method: "hover", params: { path: "/missing.R", offset: 0 } });
  assert.deepEqual(response, { id: 1, ok: true, result: undefined });
});

test("contentHash and documentation go through to the module and index", () => {
  const { call } = setup();
  assert.deepEqual(call({ method: "contentHash", params: { text: "abc" } }), { id: 1, ok: true, result: "hash:3" });
  assert.deepEqual(call({ method: "documentation", params: { name: "f" } }), { id: 2, ok: true, result: undefined });
  call(update("/a.R", "x"));
  assert.deepEqual(call({ method: "documentation", params: { name: "f" } }), { id: 4, ok: true, result: "# f" });
});

test("a panic is reported, logged, and the index is rebuilt from the last known texts", () => {
  const { call, behavior, logs } = setup();
  call(update("/a.R", "aaa"));
  call(update("/b.R", "bbb"));
  behavior.hoverPanicsFor = "/a.R";

  const response = call({ method: "hover", params: { path: "/a.R", offset: 0 } });
  assert.equal(response.ok, false);
  assert.deepEqual(!response.ok && response.error, { message: "unreachable", panic: true });
  assert.equal(behavior.constructed, 2);
  assert.equal(behavior.freed, 1);
  assert.deepEqual([...(behavior.instances[1]?.files ?? [])].sort(), [["/a.R", "aaa"], ["/b.R", "bbb"]]);
  assert.ok(logs.some(([level, message]) => level === "error" && message.includes("wasm panic in hover")));

  behavior.hoverPanicsFor = undefined;
  const after = call({ method: "hover", params: { path: "/b.R", offset: 1 } });
  assert.equal(after.ok, true);
});

test("a file whose text panics the parser is dropped, not retried forever", () => {
  const { call, behavior, logs } = setup();
  call(update("/good.R", "fine"));
  behavior.poisonMarker = "BOOM";

  const response = call(update("/bad.R", "BOOM"));
  assert.equal(response.ok, false);
  const rebuilt = behavior.instances.at(-1);
  assert.deepEqual([...(rebuilt?.files.keys() ?? [])], ["/good.R"]);
  assert.ok(!logs.some(([, message]) => message.includes("dropping /bad.R")), "poison never reached the replay");

  const listing = call({ method: "documentedFunctions", params: {} });
  assert.equal(listing.ok, true);
});

test("rebuild drops texts that panic during replay and retries without them", () => {
  const { call, behavior, logs } = setup();
  call(update("/a.R", "ok"));
  call(update("/b.R", "ok too"));
  // Becomes poisonous only after it was accepted, e.g. a state-dependent panic.
  behavior.poisonMarker = "ok too";
  behavior.hoverPanicsFor = "/a.R";

  call({ method: "hover", params: { path: "/a.R", offset: 0 } });
  const rebuilt = behavior.instances.at(-1);
  assert.deepEqual([...(rebuilt?.files.keys() ?? [])], ["/a.R"]);
  assert.ok(logs.some(([, message]) => message.includes("dropping /b.R")));
});

test("the manifest survives a rebuild", () => {
  const { call, behavior } = setup();
  call(update("/a.R", "x"));
  const json = JSON.stringify({ version: 1, files: [] });
  assert.equal(call({ method: "loadManifest", params: { json } }).ok, true);
  behavior.hoverPanicsFor = "/a.R";
  call({ method: "hover", params: { path: "/a.R", offset: 0 } });
  assert.equal(behavior.instances.at(-1)?.manifest, json);
});

test("clearManifest forgets the manifest for later rebuilds", () => {
  const { call, behavior } = setup();
  call(update("/a.R", "x"));
  call({ method: "loadManifest", params: { json: "{}" } });
  call({ method: "clearManifest", params: {} });
  behavior.hoverPanicsFor = "/a.R";
  call({ method: "hover", params: { path: "/a.R", offset: 0 } });
  assert.equal(behavior.instances.at(-1)?.manifest, undefined);
});

test("an invalid manifest is a plain error and does not rebuild the index", () => {
  const { call, behavior } = setup();
  call(update("/a.R", "x"));
  const response = call({ method: "loadManifest", params: { json: "not json" } });
  assert.equal(response.ok, false);
  assert.equal(!response.ok && response.error.panic, false);
  assert.equal(behavior.constructed, 1);
});

test("removed files are not replayed", () => {
  const { call, behavior } = setup();
  call(update("/a.R", "x"));
  call(update("/b.R", "y"));
  call({ method: "removeFiles", params: { paths: ["/a.R"] } });
  behavior.hoverPanicsFor = "/b.R";
  call({ method: "hover", params: { path: "/b.R", offset: 0 } });
  assert.deepEqual([...(behavior.instances.at(-1)?.files.keys() ?? [])], ["/b.R"]);
});

test("free failures on a poisoned instance are ignored", () => {
  const { call, behavior } = setup();
  call(update("/a.R", "x"));
  const first = behavior.instances[0];
  assert.ok(first);
  first.free = () => {
    throw new Error("already poisoned");
  };
  behavior.hoverPanicsFor = "/a.R";
  assert.doesNotThrow(() => call({ method: "hover", params: { path: "/a.R", offset: 0 } }));
  assert.equal(behavior.constructed, 2);
});

test("isPanic recognises wasm traps and rust panics but not ordinary errors", () => {
  assert.equal(isPanic(new Error("unreachable")), true);
  assert.equal(isPanic(new Error("recursive use of an object detected which would lead to unsafe aliasing in rust")), true);
  assert.equal(isPanic(new Error("null pointer passed to rust")), true);
  const trap = new Error("whatever");
  Object.defineProperty(trap, "constructor", { value: class RuntimeError {} });
  assert.equal(isPanic(trap), true);
  assert.equal(isPanic(new Error("invalid manifest: version 2")), false);
  assert.equal(isPanic("string"), false);
});
