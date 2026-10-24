import assert from "node:assert/strict";
import cp from "node:child_process";
import * as vscode from "vscode";
import type { RozoneExports } from "../../../src/extension.ts";
import { spawnLog, spawnsFromRozone } from "../spawnLog.ts";
import { activateRozone, fixture, hoversAt, hoverText, openFixture, positionOf, signatureAt, waitForInitialIndex } from "../support.ts";

let rozone: RozoneExports;

suiteSetup(async () => {
  if (vscode.workspace.isTrusted) {
    assert.fail(
      "the untrusted suite is running in a TRUSTED workspace; the launcher must drop --disable-workspace-trust " +
        "and the user data dir must not already trust the fixture folder",
    );
  }
  rozone = await activateRozone();
  await waitForInitialIndex(rozone);
});

suite("untrusted workspace", () => {
  test("the workspace really is untrusted", () => {
    assert.equal(vscode.workspace.isTrusted, false);
  });

  test("the spawn spy is live: a deliberate spawn from the test is recorded but not attributed to rozone", () => {
    const before = spawnLog().length;
    cp.spawnSync(process.platform === "win32" ? "cmd" : "/usr/bin/true", process.platform === "win32" ? ["/c", "exit"] : []);
    const recorded = spawnLog().slice(before);
    assert.ok(recorded.some((call) => call.method === "spawnSync"), "spy did not observe spawnSync");
    assert.ok(!recorded.some((call) => /[\\/]dist[\\/](extension|worker)\.cjs/.test(call.stack)));
  });

  test("base hover and signature help work", async () => {
    const doc = await openFixture("example_script.R");
    const hovers = await hoversAt(doc, positionOf(doc, "wmean({{", 2));
    assert.match(hoverText(hovers), /weighted mean/i);
    const help = await signatureAt(doc, positionOf(doc, "{{ col }}, w", "{{ col }}, ".length), ",");
    assert.equal(help?.activeParameter, 1);
  });

  test("the workspace's rozone.r.path is ignored", async () => {
    const raw = Buffer.from(await vscode.workspace.fs.readFile(fixture(".vscode", "settings.json"))).toString("utf8");
    assert.match(raw, /rozone-bogus/, "the fixture must set a bogus rozone.r.path");
    const configuration = vscode.workspace.getConfiguration("rozone");
    assert.equal(configuration.get("r.path"), "");
    assert.equal(configuration.inspect("r.path")?.workspaceValue, undefined);
  });

  test("no child process is spawned by rozone during activation or use", async () => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const offenders = spawnsFromRozone();
    assert.deepEqual(
      offenders.map((call) => `${call.method}: ${call.command}`),
      [],
      `rozone spawned a process in an untrusted workspace:\n${offenders.map((call) => call.stack).join("\n---\n")}`,
    );
  });

  test("no R process exists below the extension host", function () {
    if (process.platform === "win32") return this.skip();
    const table = cp.execFileSync("ps", ["-A", "-o", "pid=,ppid=,command="], { encoding: "utf8" });
    const rows = table
      .split("\n")
      .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => ({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] as string }));
    const descendants = new Set<number>([process.pid]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const row of rows) {
        if (descendants.has(row.ppid) && !descendants.has(row.pid)) {
          descendants.add(row.pid);
          grew = true;
        }
      }
    }
    const rProcesses = rows.filter((row) => descendants.has(row.pid) && /Rscript|sidecar\.R|(^|\/)R\s+--/.test(row.command));
    assert.deepEqual(rProcesses, []);
  });
});
