import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { SidecarController } from "../../../src/enhanced/lifecycle.ts";
import type { ControllerDeps, InjectorLike, SidecarLike, ViewState } from "../../../src/enhanced/lifecycle.ts";
import { SidecarError } from "../../../src/enhanced/sidecarClient.ts";
import type { ExitInfo, Hello } from "../../../src/enhanced/sidecarClient.ts";

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

const OK_HELLO: Hello = { event: "hello", protocol: 1, missing: [], ok: true, packages: { roxygen2: "8.1.0" } };

class FakeClient implements SidecarLike {
  helloResult: Hello | Error = OK_HELLO;
  requests: { method: string; params: any; timeoutMs: number | undefined }[] = [];
  buildImpl: (params: any) => Promise<unknown> = async (params) => ({
    manifest: { version: 1, files: params.files.map((f: any) => ({ path: f.path })) },
    lib_dir: params.install ? `${params.lib_root}/lib-1` : null,
    topics: params.files.map((f: any) => `t_${f.path}`),
    errors: [],
  });
  shutdowns = 0;
  kills = 0;
  #listeners = new Set<(info: ExitInfo) => void>();

  async start() {
    if (this.helloResult instanceof Error) throw this.helloResult;
    return this.helloResult;
  }
  async request(method: string, params?: unknown, timeoutMs?: number): Promise<any> {
    this.requests.push({ method, params, timeoutMs });
    return this.buildImpl(params);
  }
  async shutdown() {
    this.shutdowns++;
    this.#emit({ code: 0, signal: null, intentional: true });
  }
  kill() {
    this.kills++;
    this.#emit({ code: null, signal: "SIGKILL", intentional: true });
  }
  onExit(l: (info: ExitInfo) => void) {
    this.#listeners.add(l);
    return () => this.#listeners.delete(l);
  }
  crash() {
    this.#emit({ code: 1, signal: null, intentional: false });
  }
  #emit(info: ExitInfo) {
    for (const l of [...this.#listeners]) l(info);
  }
}

interface Harness {
  controller: SidecarController;
  clients: FakeClient[];
  states: ViewState[];
  manifests: string[];
  resolveCalls: number;
  trusted: boolean;
  enabled: boolean;
  positron: boolean;
  helpInjection: boolean;
  idleMinutes: number;
  files: string[];
  contents: Map<string, string>;
  hasR: boolean;
  withSession: boolean;
  roxygenNotices: number;
  roxygenMissing: readonly string[];
  fingerprintCalls: number;
  injector: InjectorLike & { injected: { sessionId: string; libDir: string; topics: readonly string[] }[]; target: { sessionId: string; libRoot: string } | undefined; cleared: number; active: boolean };
  now: number;
  nextClient: () => FakeClient;
  logs: string[];
}

function harness(overrides: Partial<ControllerDeps> = {}): Harness {
  const h = {
    clients: [] as FakeClient[],
    states: [] as ViewState[],
    manifests: [] as string[],
    resolveCalls: 0,
    trusted: true,
    enabled: true,
    positron: false,
    helpInjection: true,
    idleMinutes: 10,
    files: ["/w/a.R", "/w/b.R"],
    contents: new Map<string, string>([
      ["/w/a.R", "a <- 1"],
      ["/w/b.R", "b <- 2"],
    ]),
    hasR: true,
    withSession: true,
    roxygenNotices: 0,
    roxygenMissing: [] as readonly string[],
    fingerprintCalls: 0,
    now: 1_000_000,
    logs: [] as string[],
    injector: {
      injected: [] as { sessionId: string; libDir: string; topics: readonly string[] }[],
      target: { sessionId: "s1", libRoot: "/store/s1" } as { sessionId: string; libRoot: string } | undefined,
      cleared: 0,
      active: false,
      async buildTarget() {
        return this.target;
      },
      async inject(sessionId: string, libDir: string, topics: readonly string[]) {
        this.injected.push({ sessionId, libDir, topics });
        this.active = true;
        h.controller.updateState();
      },
      clear() {
        this.cleared++;
        this.active = false;
      },
    },
    nextClient: () => new FakeClient(),
  } as unknown as Harness;

  h.controller = new SidecarController({
    base: {
      loadManifest: async (json) => {
        h.manifests.push(json);
      },
      indexedFiles: () => h.files,
      fingerprints: async () => {
        h.fingerprintCalls++;
        return [...h.contents].map(([path, text]) => ({ path, contentHash: `hash(${text})`, docHash: `doc(${text})` }));
      },
      texts: async (paths) => paths.map((p) => h.contents.get(p) ?? null),
    },
    log: {
      info: (m) => h.logs.push(m),
      warn: (m) => h.logs.push(m),
      error: (m) => h.logs.push(m),
    },
    env: {
      isTrusted: () => h.trusted,
      isVirtual: () => false,
      get isPositron() {
        return h.positron;
      },
    },
    config: {
      enabled: () => h.enabled,
      idleMinutes: () => h.idleMinutes,
      helpInjection: () => h.helpInjection,
    },
    resolveLaunch: async () => {
      h.resolveCalls++;
      return h.hasR
        ? { ok: true, withSession: h.withSession, command: "Rscript", args: [], env: {} }
        : { ok: false, reason: "no-r" };
    },
    createClient: () => {
      const c = h.nextClient();
      h.clients.push(c);
      return c;
    },
    injector: h.injector,
    notifyRoxygenMissing: (missing) => {
      h.roxygenNotices++;
      h.roxygenMissing = missing;
    },
    onState: (s) => h.states.push(s),
    now: () => h.now,
    ...overrides,
  });
  return h;
}

const lastState = (h: Harness) => h.states.at(-1);

let edits = 0;
/** Changes a.R's text, and with it its doc hash, so the next build has something to do. */
const edit = (h: Harness) => void h.contents.set("/w/a.R", `a <- ${100 + ++edits}`);

describe("SidecarController", () => {
  beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
  afterEach(() => mock.timers.reset());

  describe("trust and config gates", () => {
    it("untrusted: no R discovery, no client, no Positron work, even with everything enabled", async () => {
      const h = harness();
      h.trusted = false;
      h.positron = true;
      await h.controller.refresh();
      h.controller.requestBuild();
      mock.timers.tick(10_000);
      await settle();
      assert.equal(h.resolveCalls, 0);
      assert.equal(h.clients.length, 0);
      assert.equal(h.injector.injected.length, 0);
      assert.deepEqual(lastState(h), { tier: "base", reason: "untrusted" });
    });

    it("untrusted: restart and reconfigure also never start anything", async () => {
      const h = harness();
      h.trusted = false;
      await h.controller.restart();
      await h.controller.reconfigure();
      assert.equal(h.resolveCalls, 0);
      assert.equal(h.clients.length, 0);
    });

    it("trust granted later starts the sidecar without a reload", async () => {
      const h = harness();
      h.trusted = false;
      await h.controller.refresh();
      assert.equal(h.clients.length, 0);
      h.trusted = true;
      await h.controller.refresh();
      assert.equal(h.clients.length, 1);
      assert.equal(h.clients[0]?.requests[0]?.method, "build");
      assert.deepEqual(lastState(h), { tier: "enhanced" });
    });

    it("disabled by setting stays base, and turning it on starts", async () => {
      const h = harness();
      h.enabled = false;
      await h.controller.refresh();
      assert.deepEqual(lastState(h), { tier: "base", reason: "disabled" });
      assert.equal(h.clients.length, 0);
      h.enabled = true;
      await h.controller.refresh();
      assert.deepEqual(lastState(h), { tier: "enhanced" });
    });

    it("disabling at runtime shuts the sidecar down", async () => {
      const h = harness();
      await h.controller.refresh();
      h.enabled = false;
      await h.controller.refresh();
      assert.equal(h.clients[0]?.shutdowns, 1);
      assert.deepEqual(lastState(h), { tier: "base", reason: "disabled" });
    });

    it("virtual workspaces stay base", async () => {
      const h = harness({ env: { isTrusted: () => true, isVirtual: () => true, isPositron: false } });
      await h.controller.refresh();
      assert.deepEqual(lastState(h), { tier: "base", reason: "virtual" });
      assert.equal(h.resolveCalls, 0);
    });

    it("no R anywhere: base/no-r, and saves do not retry", async () => {
      const h = harness();
      h.hasR = false;
      await h.controller.refresh();
      assert.deepEqual(lastState(h), { tier: "base", reason: "no-r" });
      h.controller.requestBuild();
      mock.timers.tick(1000);
      await settle();
      assert.equal(h.resolveCalls, 1);
      h.hasR = true;
      await h.controller.refresh();
      assert.deepEqual(lastState(h), { tier: "enhanced" });
    });

    it("roxygen2 missing: base/no-roxygen2, one notification per session", async () => {
      const h = harness();
      h.nextClient = () => Object.assign(new FakeClient(), { helloResult: { ...OK_HELLO, ok: false, missing: ["roxygen2"] } });
      await h.controller.refresh();
      assert.deepEqual(lastState(h), { tier: "base", reason: "no-roxygen2" });
      assert.equal(h.roxygenNotices, 1);
      await h.controller.restart();
      await h.controller.restart();
      assert.equal(h.roxygenNotices, 1);
      assert.equal(h.clients.length, 3);
      assert.ok(h.clients.every((c) => c.kills >= 1));
    });

    it("roxygen2 missing: the notification names every missing package", async () => {
      const h = harness();
      h.nextClient = () =>
        Object.assign(new FakeClient(), { helloResult: { ...OK_HELLO, ok: false, missing: ["roxygen2", "jsonlite"] } });
      await h.controller.refresh();
      assert.deepEqual(h.roxygenMissing, ["roxygen2", "jsonlite"]);
    });
  });

  describe("foreground R session", () => {
    it("retries a no-roxygen2 block once a session comes to the foreground", async () => {
      const h = harness();
      h.nextClient = () => Object.assign(new FakeClient(), { helloResult: { ...OK_HELLO, ok: false, missing: ["roxygen2"] } });
      await h.controller.refresh();
      assert.deepEqual(lastState(h), { tier: "base", reason: "no-roxygen2" });
      h.nextClient = () => new FakeClient();
      await h.controller.onForegroundSession();
      assert.deepEqual(lastState(h), { tier: "enhanced" });
      assert.equal(h.clients.length, 2);
    });

    it("relaunches a sidecar that started without a session, once", async () => {
      const h = harness();
      h.withSession = false;
      await h.controller.refresh();
      h.withSession = true;
      await h.controller.onForegroundSession();
      assert.equal(h.clients.length, 2);
      assert.equal(h.clients[0]?.shutdowns, 1);
      await h.controller.onForegroundSession();
      assert.equal(h.clients.length, 2);
    });

    it("does nothing while the sidecar is blocked as crashed", async () => {
      const h = harness();
      h.withSession = false;
      h.nextClient = () => Object.assign(new FakeClient(), { helloResult: new Error("boom") });
      await h.controller.refresh();
      for (let i = 0; i < 5; i++) {
        mock.timers.tick(5_000);
        await settle();
      }
      assert.deepEqual(lastState(h), { tier: "base", reason: "crashed" });
      const before = h.clients.length;
      await h.controller.onForegroundSession();
      assert.equal(h.clients.length, before);
    });
  });

  describe("builds", () => {
    it("initial build sends the complete file set with hashes and text, and loads the manifest", async () => {
      const h = harness();
      await h.controller.refresh();
      const request = h.clients[0]?.requests[0];
      assert.equal(request?.method, "build");
      assert.deepEqual(request?.params, {
        files: [
          { path: "/w/a.R", hash: "doc(a <- 1)", text: "a <- 1" },
          { path: "/w/b.R", hash: "doc(b <- 2)", text: "b <- 2" },
        ],
        install: false,
      });
      assert.equal(h.manifests.length, 1);
      assert.equal(JSON.parse(h.manifests[0] ?? "{}").version, 1);
    });

    it("builds only files that are both listed by discovery and held by the index", async () => {
      const h = harness();
      h.files = ["/w/a.R", "/w/gone.R"];
      await h.controller.refresh();
      assert.deepEqual(h.clients[0]?.requests[0]?.params.files.map((f: any) => f.path), ["/w/a.R"]);
    });

    it("a save with unchanged doc hashes never reaches R, even to restart an idle sidecar", async () => {
      const h = harness();
      await h.controller.refresh();
      h.controller.requestBuild();
      mock.timers.tick(300);
      await settle();
      assert.equal(h.clients[0]?.requests.length, 1);
      mock.timers.tick(10 * 60_000);
      await settle();
      assert.equal(h.controller.running, false);
      h.controller.requestBuild();
      mock.timers.tick(300);
      await settle();
      assert.equal(h.clients.length, 1);
      assert.ok(h.fingerprintCalls >= 3);
    });

    it("sends text only for files whose doc hash the running sidecar has not built", async () => {
      const h = harness();
      await h.controller.refresh();
      edit(h);
      h.controller.requestBuild();
      mock.timers.tick(300);
      await settle();
      const files = h.clients[0]?.requests[1]?.params.files;
      assert.deepEqual(files, [
        { path: "/w/a.R", hash: `doc(a <- ${100 + edits})`, text: `a <- ${100 + edits}` },
        { path: "/w/b.R", hash: "doc(b <- 2)" },
      ]);
    });

    it("a new sidecar process gets every text again", async () => {
      const h = harness();
      await h.controller.refresh();
      mock.timers.tick(10 * 60_000);
      await settle();
      edit(h);
      h.controller.requestBuild();
      mock.timers.tick(300);
      await settle();
      assert.equal(h.clients.length, 2);
      assert.ok(h.clients[1]?.requests[0]?.params.files.every((f: any) => typeof f.text === "string"));
    });

    it("a failed install is retried on the next save even when docs are unchanged", async () => {
      const h = harness();
      h.positron = true;
      const client = new FakeClient();
      client.buildImpl = async () => ({ manifest: { version: 1, files: [] }, lib_dir: null, topics: [], errors: [] });
      h.nextClient = () => client;
      await h.controller.refresh();
      h.controller.requestBuild();
      mock.timers.tick(300);
      await settle();
      assert.equal(client.requests.length, 2);
    });

    it("coalesces rapid saves into one build 300 ms after the last save", async () => {
      const h = harness();
      await h.controller.refresh();
      const client = h.clients[0];
      assert.equal(client?.requests.length, 1);
      edit(h);
      h.controller.requestBuild();
      mock.timers.tick(200);
      h.controller.requestBuild();
      mock.timers.tick(200);
      h.controller.requestBuild();
      mock.timers.tick(299);
      await settle();
      assert.equal(client?.requests.length, 1);
      mock.timers.tick(1);
      await settle();
      assert.equal(client?.requests.length, 2);
      mock.timers.tick(5000);
      await settle();
      assert.equal(client?.requests.length, 2);
    });

    it("picks up edits made between builds", async () => {
      const h = harness();
      await h.controller.refresh();
      h.contents.set("/w/a.R", "a <- 99");
      h.controller.requestBuild();
      mock.timers.tick(300);
      await settle();
      assert.equal(h.clients[0]?.requests[1]?.params.files[0].hash, "doc(a <- 99)");
    });

    it("a save during a running build triggers exactly one more build after it", async () => {
      const h = harness();
      await h.controller.refresh();
      const client = h.clients[0] as FakeClient;
      let release: () => void = () => {};
      const original = client.buildImpl;
      client.buildImpl = (params) => new Promise((resolve) => (release = () => resolve(original(params))));
      edit(h);
      h.controller.requestBuild();
      mock.timers.tick(300);
      await settle();
      assert.equal(client.requests.length, 2);
      edit(h);
      h.controller.requestBuild();
      mock.timers.tick(300);
      h.controller.requestBuild();
      mock.timers.tick(300);
      await settle();
      assert.equal(client.requests.length, 2, "serialised");
      client.buildImpl = original;
      release();
      await settle();
      assert.equal(client.requests.length, 3);
    });

    it("a remote build error is logged and does not count as a crash", async () => {
      const h = harness();
      await h.controller.refresh();
      const client = h.clients[0] as FakeClient;
      client.buildImpl = async () => {
        throw new SidecarError("remote", "kaboom");
      };
      edit(h);
      h.controller.requestBuild();
      mock.timers.tick(300);
      await settle();
      assert.ok(h.logs.some((l) => l.includes("kaboom")));
      assert.equal(h.clients.length, 1);
      assert.deepEqual(lastState(h), { tier: "enhanced" });
    });

    it("logs per-file errors from the build result", async () => {
      const h = harness();
      h.nextClient = () => {
        const c = new FakeClient();
        c.buildImpl = async () => ({ manifest: { version: 1, files: [] }, lib_dir: null, topics: [], errors: [{ path: "/w/a.R", message: "bad tag" }] });
        return c;
      };
      await h.controller.refresh();
      assert.ok(h.logs.some((l) => l.includes("/w/a.R") && l.includes("bad tag")));
    });

    it("a rejected manifest is logged, not fatal", async () => {
      const h = harness({
        base: {
          loadManifest: async () => {
            throw new Error("bad schema");
          },
          indexedFiles: () => ["/w/a.R"],
          fingerprints: async () => [{ path: "/w/a.R", contentHash: "c", docHash: "d" }],
          texts: async (paths) => paths.map(() => "a <- 1"),
        },
      });
      await h.controller.refresh();
      assert.ok(h.logs.some((l) => l.includes("bad schema")));
      assert.deepEqual(lastState(h), { tier: "enhanced" });
    });

    it("a hung build kills the sidecar and counts as a crash, then restarts", async () => {
      const h = harness();
      await h.controller.refresh();
      const client = h.clients[0] as FakeClient;
      client.buildImpl = async () => {
        throw new SidecarError("timeout", "build timed out");
      };
      edit(h);
      h.controller.requestBuild();
      mock.timers.tick(300);
      await settle();
      assert.equal(client.kills, 1);
      mock.timers.tick(1000);
      await settle();
      assert.equal(h.clients.length, 2);
    });
  });

  describe("idle shutdown", () => {
    it("shuts down after the idle timeout and restarts on the next save", async () => {
      const h = harness();
      await h.controller.refresh();
      const first = h.clients[0] as FakeClient;
      mock.timers.tick(10 * 60_000 - 1);
      await settle();
      assert.equal(first.shutdowns, 0);
      mock.timers.tick(1);
      await settle();
      assert.equal(first.shutdowns, 1);
      assert.equal(h.controller.running, false);
      assert.deepEqual(lastState(h), { tier: "enhanced" });
      assert.equal(h.clients.length, 1);

      edit(h);
      h.controller.requestBuild();
      mock.timers.tick(300);
      await settle();
      assert.equal(h.clients.length, 2);
      assert.equal(h.clients[1]?.requests[0]?.method, "build");
    });

    it("an intentional idle stop does not count as a crash", async () => {
      const h = harness();
      for (let i = 0; i < 5; i++) {
        edit(h);
        h.controller.requestBuild();
        if (i === 0) await h.controller.refresh();
        mock.timers.tick(300);
        await settle();
        mock.timers.tick(10 * 60_000);
        await settle();
      }
      assert.notDeepEqual(lastState(h), { tier: "base", reason: "crashed" });
    });

    it("each build restarts the idle clock", async () => {
      const h = harness();
      await h.controller.refresh();
      mock.timers.tick(9 * 60_000);
      edit(h);
      h.controller.requestBuild();
      mock.timers.tick(300);
      await settle();
      mock.timers.tick(9 * 60_000);
      await settle();
      assert.equal(h.clients[0]?.shutdowns, 0);
      mock.timers.tick(60_000);
      await settle();
      assert.equal(h.clients[0]?.shutdowns, 1);
    });

    it("honours a changed idle setting via rearmIdle", async () => {
      const h = harness();
      await h.controller.refresh();
      h.idleMinutes = 1;
      h.controller.rearmIdle();
      mock.timers.tick(60_000);
      await settle();
      assert.equal(h.clients[0]?.shutdowns, 1);
    });
  });

  describe("crash handling", () => {
    async function crashAndRestart(h: Harness, delayMs: number) {
      edit(h);
      h.clients.at(-1)?.crash();
      await settle();
      mock.timers.tick(delayMs);
      await settle();
    }

    it("restarts after 1 s, then 2 s, then gives up on the third crash within 5 minutes", async () => {
      const h = harness();
      await h.controller.refresh();
      assert.equal(h.clients.length, 1);

      edit(h);
      h.clients[0]?.crash();
      await settle();
      mock.timers.tick(999);
      await settle();
      assert.equal(h.clients.length, 1);
      mock.timers.tick(1);
      await settle();
      assert.equal(h.clients.length, 2);
      assert.equal(h.clients[1]?.requests[0]?.method, "build", "restart rebuilds");

      h.now += 10_000;
      edit(h);
      h.clients[1]?.crash();
      await settle();
      mock.timers.tick(1999);
      await settle();
      assert.equal(h.clients.length, 2);
      mock.timers.tick(1);
      await settle();
      assert.equal(h.clients.length, 3);

      h.now += 10_000;
      h.clients[2]?.crash();
      await settle();
      mock.timers.tick(60_000);
      await settle();
      assert.equal(h.clients.length, 3);
      assert.deepEqual(lastState(h), { tier: "base", reason: "crashed" });
    });

    it("stays base after the breaker trips: saves and refresh do nothing", async () => {
      const h = harness();
      await h.controller.refresh();
      await crashAndRestart(h, 1000);
      await crashAndRestart(h, 2000);
      h.clients.at(-1)?.crash();
      await settle();
      const count = h.clients.length;
      h.controller.requestBuild();
      mock.timers.tick(1000);
      await h.controller.refresh();
      await settle();
      assert.equal(h.clients.length, count);
      assert.deepEqual(lastState(h), { tier: "base", reason: "crashed" });
    });

    it("crashes more than 5 minutes apart never trip the breaker", async () => {
      const h = harness();
      await h.controller.refresh();
      for (let i = 0; i < 6; i++) {
        h.now += 6 * 60_000;
        await crashAndRestart(h, 1000);
      }
      assert.equal(h.clients.length, 7);
      assert.deepEqual(lastState(h), { tier: "enhanced" });
    });

    it("the restart command resets the breaker", async () => {
      const h = harness();
      await h.controller.refresh();
      await crashAndRestart(h, 1000);
      await crashAndRestart(h, 2000);
      h.clients.at(-1)?.crash();
      await settle();
      assert.deepEqual(lastState(h), { tier: "base", reason: "crashed" });
      await h.controller.restart();
      assert.deepEqual(lastState(h), { tier: "enhanced" });
    });

    it("a sidecar that fails to start is retried with the same backoff and breaker", async () => {
      const h = harness();
      h.nextClient = () => Object.assign(new FakeClient(), { helloResult: new SidecarError("exit", "died") });
      await h.controller.refresh();
      assert.equal(h.clients.length, 1);
      mock.timers.tick(1000);
      await settle();
      assert.equal(h.clients.length, 2);
      mock.timers.tick(2000);
      await settle();
      assert.equal(h.clients.length, 3);
      mock.timers.tick(60_000);
      await settle();
      assert.equal(h.clients.length, 3);
      assert.deepEqual(lastState(h), { tier: "base", reason: "crashed" });
    });
  });

  describe("Positron injection", () => {
    it("requests an install build and hands lib_dir and topics to the injector", async () => {
      const h = harness();
      h.positron = true;
      await h.controller.refresh();
      assert.equal(h.clients[0]?.requests[0]?.params.install, true);
      assert.equal(h.clients[0]?.requests[0]?.params.lib_root, "/store/s1");
      assert.deepEqual(h.injector.injected, [
        { sessionId: "s1", libDir: "/store/s1/lib-1", topics: ["t_/w/a.R", "t_/w/b.R"] },
      ]);
      assert.deepEqual(lastState(h), { tier: "enhanced+help" });
    });

    it("does not install when there is no foreground R session", async () => {
      const h = harness();
      h.positron = true;
      h.injector.target = undefined;
      await h.controller.refresh();
      assert.equal(h.clients[0]?.requests[0]?.params.install, false);
      assert.equal("lib_root" in (h.clients[0]?.requests[0]?.params ?? {}), false);
      assert.equal(h.injector.injected.length, 0);
    });

    it("does not install in plain VS Code", async () => {
      const h = harness();
      await h.controller.refresh();
      assert.equal(h.clients[0]?.requests[0]?.params.install, false);
      assert.equal(h.injector.injected.length, 0);
    });

    it("does not install when rozone.helpInjection is off", async () => {
      const h = harness();
      h.positron = true;
      h.helpInjection = false;
      await h.controller.refresh();
      assert.equal(h.clients[0]?.requests[0]?.params.install, false);
      assert.deepEqual(lastState(h), { tier: "enhanced" });
    });

    it("turning helpInjection off clears the injector and drops back to enhanced", async () => {
      const h = harness();
      h.positron = true;
      await h.controller.refresh();
      h.helpInjection = false;
      await h.controller.reconfigure();
      assert.equal(h.injector.cleared, 1);
      assert.deepEqual(lastState(h), { tier: "enhanced" });
    });
  });

  describe("lifecycle end", () => {
    it("dispose kills the sidecar and cancels timers", async () => {
      const h = harness();
      await h.controller.refresh();
      h.controller.requestBuild();
      h.controller.dispose();
      assert.equal(h.clients[0]?.kills, 1);
      mock.timers.tick(60 * 60_000);
      await settle();
      assert.equal(h.clients[0]?.requests.length, 1);
      assert.equal(h.clients[0]?.shutdowns, 0);
    });

    it("dispose during startup does not leave a client running", async () => {
      const h = harness();
      const pending = h.controller.refresh();
      h.controller.dispose();
      await pending;
      await settle();
      assert.ok(h.clients.every((c) => c.kills >= 1 || c.requests.length === 0));
      assert.equal(h.controller.running, false);
    });

    it("emits each state only once", async () => {
      const h = harness();
      await h.controller.refresh();
      h.controller.updateState();
      h.controller.updateState();
      assert.deepEqual(h.states, [{ tier: "starting" }, { tier: "enhanced" }]);
    });
  });
});
