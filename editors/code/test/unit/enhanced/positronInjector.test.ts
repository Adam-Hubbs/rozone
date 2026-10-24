import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { EvalOutcome, PositronBridge, RSession, SessionState } from "../../../src/enhanced/positronBridge.ts";
import { injectionSnippet, PositronInjector, rStringLiteral } from "../../../src/enhanced/positronInjector.ts";

describe("injection snippet", () => {
  it("matches the contract shape", () => {
    assert.equal(
      injectionSnippet("/tmp/lib-1"),
      [
        "local({",
        '  if (isNamespaceLoaded("rozone.docs")) unloadNamespace("rozone.docs")',
        '  loadNamespace("rozone.docs", lib.loc = "/tmp/lib-1")',
        "  invisible()",
        "})",
      ].join("\n"),
    );
  });

  it("escapes backslashes, quotes and newlines", () => {
    assert.equal(rStringLiteral('C:\\Users\\a "b"'), '"C:\\\\Users\\\\a \\"b\\""');
    assert.equal(rStringLiteral("a\nb\r"), '"a\\nb\\r"');
  });

  it("cannot be broken out of by a hostile path", () => {
    const snippet = injectionSnippet('x"); system("boom"); ("');
    assert.ok(snippet.includes('lib.loc = "x\\"); system(\\"boom\\"); (\\""'));
  });
});

class FakeBridge implements PositronBridge {
  session: RSession | undefined = { id: "s1", runtimePath: "/r/bin/R" };
  outcomes: EvalOutcome[] = [];
  evaluated: { sessionId: string; code: string }[] = [];
  fgListeners = new Set<(s: RSession | undefined) => void>();
  stateListeners = new Set<(e: { sessionId: string; state: SessionState }) => void>();

  foregroundSession = async () => this.session;
  evaluate = async (sessionId: string, code: string): Promise<EvalOutcome> => {
    this.evaluated.push({ sessionId, code });
    return this.outcomes.shift() ?? { status: "ok", value: null };
  };
  onDidChangeForegroundSession(l: (s: RSession | undefined) => void) {
    this.fgListeners.add(l);
    return { dispose: () => this.fgListeners.delete(l) };
  }
  onDidChangeSessionState(l: (e: { sessionId: string; state: SessionState }) => void) {
    this.stateListeners.add(l);
    return { dispose: () => this.stateListeners.delete(l) };
  }
  setState(sessionId: string, state: SessionState) {
    for (const l of this.stateListeners) l({ sessionId, state });
  }
  switchTo(session: RSession | undefined) {
    this.session = session;
    for (const l of this.fgListeners) l(session);
  }
}

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

describe("PositronInjector", () => {
  let bridge: FakeBridge;
  let topics: string[][];
  let active: boolean[];
  let injector: PositronInjector;

  beforeEach(() => {
    bridge = new FakeBridge();
    topics = [];
    active = [];
    injector = new PositronInjector({
      bridge,
      log: { info() {}, warn() {}, error() {} },
      setInjectedTopics: (names) => topics.push([...names].sort()),
      onActiveChange: (a) => active.push(a),
    });
  });

  it("injects into the foreground session and publishes the topics", async () => {
    await injector.inject("/lib-1", ["b", "a"]);
    assert.equal(bridge.evaluated.length, 1);
    assert.equal(bridge.evaluated[0]?.sessionId, "s1");
    assert.ok(bridge.evaluated[0]?.code.includes('"/lib-1"'));
    assert.deepEqual(topics.at(-1), ["a", "b"]);
    assert.deepEqual(active, [true]);
    assert.equal(injector.active, true);
  });

  it("does nothing when there is no session (never starts one)", async () => {
    bridge.session = undefined;
    await injector.inject("/lib-1", ["a"]);
    assert.equal(bridge.evaluated.length, 0);
    assert.equal(injector.active, false);
  });

  it("retries on the next idle state when the session is busy", async () => {
    bridge.outcomes = [{ status: "busy" }];
    await injector.inject("/lib-1", ["a"]);
    assert.equal(injector.active, false);
    bridge.setState("s1", "busy");
    await settle();
    assert.equal(bridge.evaluated.length, 1);
    bridge.setState("s1", "idle");
    await settle();
    assert.equal(bridge.evaluated.length, 2);
    assert.equal(injector.active, true);
  });

  it("does not re-inject the same lib after the session goes idle again", async () => {
    await injector.inject("/lib-1", ["a"]);
    bridge.setState("s1", "busy");
    bridge.setState("s1", "idle");
    await settle();
    assert.equal(bridge.evaluated.length, 1);
  });

  it("injects a newer generation into an already injected session", async () => {
    await injector.inject("/lib-1", ["a"]);
    await injector.inject("/lib-2", ["a", "c"]);
    assert.equal(bridge.evaluated.length, 2);
    assert.deepEqual(topics.at(-1), ["a", "c"]);
  });

  it("clears topics on session exit and re-injects after a restart", async () => {
    await injector.inject("/lib-1", ["a"]);
    bridge.setState("s1", "exited");
    assert.deepEqual(topics.at(-1), []);
    assert.equal(injector.active, false);
    bridge.setState("s1", "starting");
    bridge.setState("s1", "ready");
    await settle();
    assert.equal(bridge.evaluated.length, 2);
    assert.deepEqual(topics.at(-1), ["a"]);
    assert.equal(injector.active, true);
  });

  it("re-injects when the foreground session changes", async () => {
    await injector.inject("/lib-1", ["a"]);
    bridge.switchTo({ id: "s2", runtimePath: "/r/bin/R" });
    await settle();
    assert.deepEqual(bridge.evaluated.map((e) => e.sessionId), ["s1", "s2"]);
    assert.equal(injector.active, true);
  });

  it("goes inactive when the foreground session disappears", async () => {
    await injector.inject("/lib-1", ["a"]);
    bridge.switchTo(undefined);
    await settle();
    assert.equal(injector.active, false);
    assert.deepEqual(active, [true, false]);
  });

  it("ignores exits of other sessions", async () => {
    await injector.inject("/lib-1", ["a"]);
    bridge.setState("other", "exited");
    assert.equal(injector.active, true);
  });

  it("logs evaluation errors and stays inactive", async () => {
    bridge.outcomes = [{ status: "error", message: "boom" }];
    await injector.inject("/lib-1", ["a"]);
    assert.equal(injector.active, false);
  });

  it("clear() forgets the build and the topics", async () => {
    await injector.inject("/lib-1", ["a"]);
    injector.clear();
    assert.deepEqual(topics.at(-1), []);
    bridge.setState("s1", "idle");
    await settle();
    assert.equal(bridge.evaluated.length, 1);
  });

  it("stops listening after dispose", async () => {
    injector.dispose();
    assert.equal(bridge.fgListeners.size, 0);
    assert.equal(bridge.stateListeners.size, 0);
  });
});
