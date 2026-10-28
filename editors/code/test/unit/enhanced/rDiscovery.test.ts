import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EvalOutcome, PositronBridge, RSession } from "../../../src/enhanced/positronBridge.ts";
import {
  buildLaunch,
  discoverRscript,
  findOnPath,
  LaunchResolver,
  parseLibPaths,
  rscriptNextTo,
  waitForForegroundSession,
} from "../../../src/enhanced/rDiscovery.ts";

const filesystem = (...paths: string[]) => {
  const set = new Set(paths);
  return (p: string) => set.has(p);
};

describe("rscriptNextTo", () => {
  it("finds Rscript beside R", () => {
    assert.equal(rscriptNextTo("/opt/R/bin/R", "linux", filesystem("/opt/R/bin/Rscript")), "/opt/R/bin/Rscript");
  });

  it("uses an Rscript path as is", () => {
    assert.equal(rscriptNextTo("/opt/R/bin/Rscript", "linux", filesystem("/opt/R/bin/Rscript")), "/opt/R/bin/Rscript");
  });

  it("uses Rscript.exe on Windows, including from R.exe", () => {
    const fs = filesystem("C:\\R\\bin\\x64\\Rscript.exe");
    assert.equal(rscriptNextTo("C:\\R\\bin\\x64\\R.exe", "win32", fs), "C:\\R\\bin\\x64\\Rscript.exe");
    assert.equal(rscriptNextTo("C:\\R\\bin\\x64\\Rscript.exe", "win32", fs), "C:\\R\\bin\\x64\\Rscript.exe");
  });

  it("returns undefined when the sibling is missing", () => {
    assert.equal(rscriptNextTo("/opt/R/bin/R", "linux", filesystem()), undefined);
  });
});

describe("findOnPath", () => {
  it("returns the first directory containing Rscript", () => {
    const fs = filesystem("/b/Rscript", "/c/Rscript");
    assert.equal(findOnPath("/a:/b:/c", "linux", fs), "/b/Rscript");
  });

  it("splits on ; and looks for .exe on Windows", () => {
    assert.equal(findOnPath("C:\\x;C:\\R\\bin", "win32", filesystem("C:\\R\\bin\\Rscript.exe")), "C:\\R\\bin\\Rscript.exe");
  });

  it("handles empty or missing PATH", () => {
    assert.equal(findOnPath(undefined, "linux", filesystem()), undefined);
    assert.equal(findOnPath("::", "linux", filesystem()), undefined);
  });
});

describe("discoverRscript precedence", () => {
  const base = { platform: "linux" as const, pathEnv: "/usr/bin", settingPath: "" };
  const fs = filesystem("/pos/bin/Rscript", "/set/bin/Rscript", "/usr/bin/Rscript");

  it("prefers the Positron session's R", () => {
    assert.equal(
      discoverRscript({ ...base, isFile: fs, positronRuntimePath: "/pos/bin/R", settingPath: "/set/bin/Rscript" }),
      "/pos/bin/Rscript",
    );
  });

  it("falls back to the setting, then PATH", () => {
    assert.equal(discoverRscript({ ...base, isFile: fs, settingPath: "/set/bin/Rscript" }), "/set/bin/Rscript");
    assert.equal(discoverRscript({ ...base, isFile: fs }), "/usr/bin/Rscript");
  });

  it("skips a Positron path with no Rscript beside it", () => {
    assert.equal(
      discoverRscript({ ...base, isFile: fs, positronRuntimePath: "/gone/bin/R", settingPath: "/set/bin/Rscript" }),
      "/set/bin/Rscript",
    );
  });

  it("ignores a setting that does not exist", () => {
    assert.equal(discoverRscript({ ...base, isFile: fs, settingPath: "/nope/Rscript" }), "/usr/bin/Rscript");
  });

  it("returns undefined when R is nowhere", () => {
    assert.equal(discoverRscript({ ...base, isFile: filesystem() }), undefined);
  });
});

describe("parseLibPaths", () => {
  it("accepts arrays", () => assert.deepEqual(parseLibPaths(["/a", "/b", 3]), ["/a", "/b"]));
  it("accepts printed vectors", () => assert.deepEqual(parseLibPaths('[1] "/a b" "/c"'), ["/a b", "/c"]));
  it("accepts newline separated paths", () => assert.deepEqual(parseLibPaths("/a\n/b\n"), ["/a", "/b"]));
  it("accepts a mime bundle", () => assert.deepEqual(parseLibPaths({ "text/plain": '[1] "/a"' }), ["/a"]));
  it("unescapes Windows paths", () => assert.deepEqual(parseLibPaths('[1] "C:\\\\R\\\\library"'), ["C:\\R\\library"]));
  it("returns [] for anything else", () => assert.deepEqual(parseLibPaths(42), []));
});

describe("buildLaunch", () => {
  const common = { rscript: "/r/Rscript", sidecarScript: "/ext/r/sidecar.R", baseEnv: { PATH: "/bin" } };

  it("Positron: --no-init-file and R_LIBS from the session", () => {
    const spec = buildLaunch({ ...common, platform: "linux", positron: true, libPaths: ["/l1", "/l2"] });
    assert.deepEqual(spec.args, ["--no-init-file", "/ext/r/sidecar.R"]);
    assert.equal(spec.env["R_LIBS"], "/l1:/l2");
    assert.equal(spec.env["PATH"], "/bin");
    assert.equal(spec.command, "/r/Rscript");
  });

  it("VS Code: no --no-init-file so renv activates, and R_LIBS untouched", () => {
    const spec = buildLaunch({ ...common, platform: "linux", positron: false, libPaths: [] });
    assert.deepEqual(spec.args, ["/ext/r/sidecar.R"]);
    assert.equal("R_LIBS" in spec.env, false);
  });

  it("joins library paths with ; on Windows", () => {
    const spec = buildLaunch({ ...common, platform: "win32", positron: true, libPaths: ["C:\\a", "C:\\b"] });
    assert.equal(spec.env["R_LIBS"], "C:\\a;C:\\b");
  });

  it("does not mutate the base environment", () => {
    const baseEnv = { PATH: "/bin" };
    buildLaunch({ ...common, baseEnv, platform: "linux", positron: true, libPaths: ["/l"] });
    assert.deepEqual(baseEnv, { PATH: "/bin" });
  });
});

describe("LaunchResolver", () => {
  const silent = { info() {}, warn() {} };

  function fakeBridge(evaluateResult: EvalOutcome, runtimePath = "/pos/bin/R") {
    const evaluated: string[] = [];
    const bridge: PositronBridge = {
      foregroundSession: async () => ({ id: "s1", runtimePath }),
      evaluate: async (_id, code) => {
        evaluated.push(code);
        return evaluateResult;
      },
      onDidChangeForegroundSession: () => ({ dispose() {} }),
      onDidChangeSessionState: () => ({ dispose() {} }),
      executeInConsole: async () => {},
      activeSessionIds: async () => ["s1"],
      onDidEndSession: () => ({ dispose() {} }),
    };
    return { bridge, evaluated };
  }

  /** A Positron with no foreground session yet; `appear()` brings one up. */
  function lateBridge() {
    const { bridge } = fakeBridge({ status: "ok", value: ["/l1"] });
    let current: RSession | undefined;
    const listeners = new Set<(s: RSession | undefined) => void>();
    const late: PositronBridge = {
      ...bridge,
      foregroundSession: async () => current,
      onDidChangeForegroundSession: (l) => {
        listeners.add(l);
        return { dispose: () => listeners.delete(l) };
      },
    };
    const appear = () => {
      current = { id: "s1", runtimePath: "/pos/bin/R" };
      for (const l of listeners) l(current);
    };
    return { bridge: late, appear, listeners };
  }

  const deps = (positron?: PositronBridge) => ({
    platform: "linux" as const,
    isFile: filesystem("/pos/bin/Rscript", "/usr/bin/Rscript"),
    pathEnv: "/usr/bin",
    baseEnv: { PATH: "/usr/bin" },
    settingPath: () => "",
    sidecarScript: "/ext/r/sidecar.R",
    positron,
    log: silent,
  });

  it("Positron: uses the session R and its .libPaths(), read once", async () => {
    const { bridge, evaluated } = fakeBridge({ status: "ok", value: ["/l1", "/l2"] });
    const resolver = new LaunchResolver(deps(bridge));
    const first = await resolver.resolve();
    assert.ok(first.ok);
    assert.equal(first.command, "/pos/bin/Rscript");
    assert.deepEqual(first.args, ["--no-init-file", "/ext/r/sidecar.R"]);
    assert.equal(first.env["R_LIBS"], "/l1:/l2");
    await resolver.resolve();
    assert.deepEqual(evaluated, [".libPaths()"]);
    resolver.reset();
    await resolver.resolve();
    assert.equal(evaluated.length, 2);
  });

  it("Positron with a busy session: starts without R_LIBS and retries next time", async () => {
    const { bridge, evaluated } = fakeBridge({ status: "busy" });
    const resolver = new LaunchResolver(deps(bridge));
    const result = await resolver.resolve();
    assert.ok(result.ok);
    assert.equal("R_LIBS" in result.env, false);
    await resolver.resolve();
    assert.equal(evaluated.length, 2);
  });

  it("plain VS Code: PATH Rscript, no evaluation, no --no-init-file", async () => {
    const result = await new LaunchResolver(deps()).resolve();
    assert.ok(result.ok);
    assert.equal(result.command, "/usr/bin/Rscript");
    assert.deepEqual(result.args, ["/ext/r/sidecar.R"]);
  });

  it("reports no-r when nothing is found", async () => {
    const resolver = new LaunchResolver({ ...deps(), isFile: filesystem() });
    assert.deepEqual(await resolver.resolve(), { ok: false, reason: "no-r" });
  });

  it("Positron: waits for a session that comes up after activation and uses its libraries", async () => {
    const { bridge, appear } = lateBridge();
    const pending = new LaunchResolver({ ...deps(bridge), sessionWaitMs: 5_000 }).resolve();
    await new Promise((r) => setImmediate(r));
    appear();
    const result = await pending;
    assert.ok(result.ok);
    assert.equal(result.withSession, true);
    assert.equal(result.command, "/pos/bin/Rscript");
    assert.equal(result.env["R_LIBS"], "/l1");
  });

  it("Positron with no session at all: gives up after the wait and launches without one", async () => {
    const { bridge, listeners } = lateBridge();
    const result = await new LaunchResolver({ ...deps(bridge), sessionWaitMs: 10 }).resolve();
    assert.ok(result.ok);
    assert.equal(result.withSession, false);
    assert.equal(result.command, "/usr/bin/Rscript");
    assert.equal(listeners.size, 0);
  });
});

describe("waitForForegroundSession", () => {
  it("resolves immediately with an existing session and unsubscribes", async () => {
    let subscribed = 0;
    let disposed = 0;
    const bridge = {
      foregroundSession: async () => ({ id: "s1", runtimePath: "/r" }),
      onDidChangeForegroundSession: () => {
        subscribed++;
        return { dispose: () => void disposed++ };
      },
    } as unknown as PositronBridge;
    assert.deepEqual(await waitForForegroundSession(bridge, 60_000), { id: "s1", runtimePath: "/r" });
    assert.equal(disposed, subscribed);
  });
});
