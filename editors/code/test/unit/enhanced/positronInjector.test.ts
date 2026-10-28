import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { EvalOutcome, PositronBridge, RSession, SessionState } from "../../../src/enhanced/positronBridge.ts";
import { LibStore } from "../../../src/enhanced/libStore.ts";
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
  endListeners = new Map<string, Set<(reason: string) => void>>();
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
  activeSessionIds = async () => (this.session ? [this.session.id] : []);
  onDidEndSession(id: string, l: (reason: string) => void) {
    const set = this.endListeners.get(id) ?? new Set();
    this.endListeners.set(id, set);
    set.add(l);
    return { dispose: () => set.delete(l) };
  }
  endSession(id: string, reason: string) {
    for (const l of [...(this.endListeners.get(id) ?? [])]) l(reason);
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
  let dir: string;
  let store: LibStore;
  let buildRequests: number;
  const warnings: string[] = [];
  const lib = (session: string, n: number) => join(dir, session, `lib-${n}`);
  const mk = (session: string, n: number) => {
    mkdirSync(lib(session, n), { recursive: true });
    return lib(session, n);
  };

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rozone-injector-"));
    warnings.length = 0;
    buildRequests = 0;
    bridge = new FakeBridge();
    topics = [];
    active = [];
    store = new LibStore(dir, { info() {}, warn: (m) => warnings.push(m), error() {} });
    injector = new PositronInjector({
      bridge,
      store,
      requestBuild: () => {
        buildRequests++;
      },
      log: { info() {}, warn: (m) => warnings.push(m), error() {} },
      setInjectedTopics: (names) => topics.push([...names].sort()),
      onActiveChange: (a) => active.push(a),
    });
  });

  it("injects into the foreground session and publishes the topics", async () => {
    await injector.inject("s1", "/lib-1", ["b", "a"]);
    assert.equal(bridge.evaluated.length, 1);
    assert.equal(bridge.evaluated[0]?.sessionId, "s1");
    assert.ok(bridge.evaluated[0]?.code.includes('"/lib-1"'));
    assert.deepEqual(topics.at(-1), ["a", "b"]);
    assert.deepEqual(active, [true]);
    assert.equal(injector.active, true);
  });

  it("does nothing when there is no session (never starts one)", async () => {
    bridge.session = undefined;
    await injector.inject("s1", "/lib-1", ["a"]);
    assert.equal(bridge.evaluated.length, 0);
    assert.equal(injector.active, false);
  });

  it("retries on the next idle state when the session is busy", async () => {
    bridge.outcomes = [{ status: "busy" }];
    await injector.inject("s1", "/lib-1", ["a"]);
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
    await injector.inject("s1", "/lib-1", ["a"]);
    bridge.setState("s1", "busy");
    bridge.setState("s1", "idle");
    await settle();
    assert.equal(bridge.evaluated.length, 1);
  });

  it("injects a newer generation into an already injected session", async () => {
    await injector.inject("s1", "/lib-1", ["a"]);
    await injector.inject("s1", "/lib-2", ["a", "c"]);
    assert.equal(bridge.evaluated.length, 2);
    assert.deepEqual(topics.at(-1), ["a", "c"]);
  });

  it("clears topics on session exit and re-injects after a restart", async () => {
    await injector.inject("s1", "/lib-1", ["a"]);
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
    await injector.inject("s1", "/lib-1", ["a"]);
    bridge.switchTo({ id: "s2", runtimePath: "/r/bin/R" });
    await settle();
    assert.equal(injector.active, false);
    await injector.inject("s2", "/lib-2", ["a"]);
    assert.deepEqual(bridge.evaluated.map((e) => e.sessionId), ["s1", "s2"]);
    assert.equal(injector.active, true);
  });

  it("never injects another session's folder; requests a build instead", async () => {
    bridge.session = { id: "s2", runtimePath: "/r/bin/R" };
    await injector.inject("s1", "/lib-1", ["a"]);
    assert.equal(bridge.evaluated.length, 0);
    assert.equal(buildRequests, 1);
    assert.equal(injector.active, false);
  });

  it("requests a build when the foreground session changes to one without a library", async () => {
    await injector.inject("s1", "/lib-1", ["a"]);
    bridge.switchTo({ id: "s2", runtimePath: "/r/bin/R" });
    await settle();
    assert.equal(buildRequests, 1);
    assert.equal(bridge.evaluated.length, 1);
  });

  it("requests a build only once per foreground session, not on every idle", async () => {
    await injector.inject("s1", "/lib-1", ["a"]);
    bridge.switchTo({ id: "s2", runtimePath: "/r/bin/R" });
    await settle();
    bridge.setState("s2", "idle");
    await settle();
    bridge.setState("s2", "idle");
    await settle();
    assert.equal(buildRequests, 1);
    bridge.switchTo({ id: "s1", runtimePath: "/r/bin/R" });
    await settle();
    bridge.switchTo({ id: "s2", runtimePath: "/r/bin/R" });
    await settle();
    assert.equal(buildRequests, 2);
  });

  it("buildTarget points at the foreground session's folder, or nothing", async () => {
    assert.deepEqual(await injector.buildTarget(), { sessionId: "s1", libRoot: join(dir, "s1") });
    bridge.session = undefined;
    assert.equal(await injector.buildTarget(), undefined);
  });

  it("prunes older libs of the session after a successful injection only", async () => {
    mk("s1", 1);
    mk("s1", 2);
    const keep = mk("s1", 3);
    const other = mk("s2", 1);
    await injector.inject("s1", keep, ["a"]);
    assert.ok(existsSync(keep));
    assert.ok(!existsSync(lib("s1", 1)));
    assert.ok(!existsSync(lib("s1", 2)));
    assert.ok(existsSync(other));
  });

  it("deletes nothing when the session is busy or evaluation fails", async () => {
    mk("s1", 1);
    const next = mk("s1", 2);
    bridge.outcomes = [{ status: "busy" }, { status: "error", message: "boom" }];
    await injector.inject("s1", next, ["a"]);
    await injector.inject("s1", next, ["a"]);
    assert.ok(existsSync(lib("s1", 1)));
    assert.ok(existsSync(next));
  });

  for (const [reason, removed] of [
    ["shutdown", true],
    ["forcedQuit", true],
    ["switchRuntime", true],
    ["error", true],
    ["startupFailed", true],
    ["unknown", true],
    ["restart", false],
    ["transferred", false],
    ["extensionHost", false],
  ] as const) {
    it(`session end (${reason}) ${removed ? "removes" : "keeps"} the session folder`, async () => {
      const keep = mk("s1", 1);
      await injector.buildTarget();
      bridge.endSession("s1", reason);
      await settle();
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(existsSync(keep), !removed);
    });
  }

  it("forgets the pending build of an ended session", async () => {
    mk("s1", 1);
    await injector.buildTarget();
    await injector.inject("s1", lib("s1", 1), ["a"]);
    bridge.endSession("s1", "shutdown");
    await settle();
    assert.equal(injector.active, false);
    bridge.setState("s1", "idle");
    await settle();
    assert.equal(bridge.evaluated.length, 1);
  });

  it("watches each session once and stops watching on dispose", async () => {
    await injector.buildTarget();
    await injector.buildTarget();
    assert.equal(bridge.endListeners.get("s1")?.size, 1);
    injector.dispose();
    assert.equal(bridge.endListeners.get("s1")?.size, 0);
  });

  it("goes inactive when the foreground session disappears", async () => {
    await injector.inject("s1", "/lib-1", ["a"]);
    bridge.switchTo(undefined);
    await settle();
    assert.equal(injector.active, false);
    assert.deepEqual(active, [true, false]);
  });

  it("ignores exits of other sessions", async () => {
    await injector.inject("s1", "/lib-1", ["a"]);
    bridge.setState("other", "exited");
    assert.equal(injector.active, true);
  });

  it("logs evaluation errors and stays inactive", async () => {
    bridge.outcomes = [{ status: "error", message: "boom" }];
    await injector.inject("s1", "/lib-1", ["a"]);
    assert.equal(injector.active, false);
  });

  it("clear() forgets the build and the topics", async () => {
    await injector.inject("s1", "/lib-1", ["a"]);
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
