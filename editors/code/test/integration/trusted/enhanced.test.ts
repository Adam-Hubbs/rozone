import assert from "node:assert/strict";
import cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { RozoneExports } from "../../../src/extension.ts";
import {
  activateRozone,
  appendText,
  fsPathOf,
  hoversAt,
  hoverText,
  openFixture,
  positionOf,
  resetEditors,
  signatureAt,
  waitFor,
  waitForInitialIndex,
} from "../support.ts";

// PLAN section 6: trusted workspace, real Rscript and r/sidecar.R, no fakes.

function findRscript(): string | undefined {
  const exe = process.platform === "win32" ? "Rscript.exe" : "Rscript";
  return (process.env["PATH"] ?? "")
    .split(path.delimiter)
    .map((dir) => path.join(dir, exe))
    .find((candidate) => fs.existsSync(candidate));
}

function hasPackage(rscript: string, name: string): boolean {
  return cp.spawnSync(rscript, ["-e", `quit(status = !requireNamespace("${name}", quietly = TRUE))`]).status === 0;
}

const rscript = findRscript();
const haveRoxygen = rscript !== undefined && hasPackage(rscript, "roxygen2") && hasPackage(rscript, "jsonlite");
const haveDplyr = rscript !== undefined && hasPackage(rscript, "dplyr");

let rozone: RozoneExports;
const isEnhanced = () => {
  const tier = rozone._test.enhanced.state()?.tier;
  return tier === "enhanced" || tier === "enhanced+help";
};

const hoverAtCall = async (...segments: string[]) => {
  const file = fsPathOf(...segments);
  const doc = await openFixture(...segments);
  return { file, doc };
};

suite("enhanced tier end to end (real Rscript and sidecar.R)", function () {
  this.timeout(120_000);

  suiteSetup(async function () {
    if (!haveRoxygen) {
      console.log("SKIPPED enhanced e2e: Rscript with roxygen2 and jsonlite was not found on PATH");
      return this.skip();
    }
    rozone = await activateRozone();
    await waitForInitialIndex(rozone);
    assert.equal(vscode.workspace.isTrusted, true);
    // The 4000-function generated file would make roxygen2 take far longer than these timeouts.
    const configuration = vscode.workspace.getConfiguration("rozone");
    await configuration.update("files.exclude", ["**/renv/**", "**/.git/**", "**/generated/**"], vscode.ConfigurationTarget.Workspace);
    await waitFor("the generated files to leave the index", () => !rozone.base.indexedFiles().some((file) => file.includes("generated")));
    await vscode.workspace.getConfiguration("rozone").update("r.path", rscript, vscode.ConfigurationTarget.Workspace);
    await waitFor("the sidecar to start and the tier to report enhanced", isEnhanced, 90_000);
  });

  suiteTeardown(async () => {
    rozone?._test.enhanced.setIdleMinutes(undefined);
    await resetEditors();
  });

  test("the sidecar is running and the tier state is enhanced", () => {
    assert.ok(isEnhanced(), JSON.stringify(rozone._test.enhanced.state()));
    const pid = rozone._test.enhanced.sidecarPid();
    assert.ok(pid && pid > 0, "expected a sidecar pid");
    process.kill(pid, 0);
  });

  test("hover eventually comes from the roxygen2 manifest", async () => {
    const { file, doc } = await hoverAtCall("example_script.R");
    const offset = doc.offsetAt(positionOf(doc, "wmean({{", 2));
    const hover = await waitFor(
      "a manifest-sourced hover",
      async () => {
        const result = await rozone._test.tier.client.hover(file, offset);
        return result?.source === "manifest" ? result : undefined;
      },
      10_000,
    );
    assert.match(hover.markdown, /weighted mean/i);
  });

  test("@inheritParams dplyr::mutate resolves in hover or signature help", async function () {
    if (!haveDplyr) {
      console.log("SKIPPED @inheritParams dplyr::mutate: dplyr is not installed");
      return this.skip();
    }
    const { doc } = await hoverAtCall("enhanced", "dplyr_inherit.R");
    await waitFor(
      "dplyr's .data description",
      async () => {
        const hovers = await hoversAt(doc, positionOf(doc, "mutate_plus(mtcars", 3));
        const help = await signatureAt(doc, positionOf(doc, "mutate_plus(mtcars", "mutate_plus(".length), "(");
        const parameterDocs = (help?.signatures[0]?.parameters ?? [])
          .map((parameter) => (typeof parameter.documentation === "string" ? parameter.documentation : parameter.documentation?.value))
          .join("\n");
        return /data frame/i.test(`${hoverText(hovers)}\n${parameterDocs}`);
      },
      10_000,
    );
  });

  test("saving an edit to a #' line updates the hover within about a second", async () => {
    const { file, doc } = await hoverAtCall("enhanced", "live_edit.R");
    const offset = doc.offsetAt(positionOf(doc, "live_edit_fn(1)", 2));
    await waitFor("initial manifest hover", async () => (await rozone._test.tier.client.hover(file, offset))?.source === "manifest", 10_000);

    await vscode.window.showTextDocument(doc);
    const edit = new vscode.WorkspaceEdit();
    const at = positionOf(doc, "Original title for the save test");
    edit.replace(doc.uri, new vscode.Range(at, at.translate(0, "Original title for the save test".length)), "Edited title after save");
    await vscode.workspace.applyEdit(edit);

    const saved = performance.now();
    await doc.save();
    await waitFor(
      "the saved edit in a manifest hover",
      async () => {
        const result = await rozone._test.tier.client.hover(file, offset);
        return result?.source === "manifest" && result.markdown.includes("Edited title after save");
      },
      5_000,
    );
    const elapsed = performance.now() - saved;
    console.log(`save to manifest hover: ${elapsed.toFixed(0)} ms`);
    assert.ok(elapsed < 1500, `took ${elapsed} ms`);
  });

  test("a sidecar killed from outside is restarted", async () => {
    const before = rozone._test.enhanced.sidecarPid();
    assert.ok(before);
    process.kill(before, "SIGKILL");
    const after = await waitFor(
      "a replacement sidecar",
      () => {
        const pid = rozone._test.enhanced.sidecarPid();
        return pid !== undefined && pid !== before && isEnhanced() ? pid : undefined;
      },
      60_000,
    );
    assert.notEqual(after, before);
    const { file, doc } = await hoverAtCall("example_script.R");
    const offset = doc.offsetAt(positionOf(doc, "wmean({{", 2));
    await waitFor("manifest hover after restart", async () => (await rozone._test.tier.client.hover(file, offset))?.source === "manifest", 15_000);
  });

  test("the sidecar exits after the idle timeout", async () => {
    const pid = rozone._test.enhanced.sidecarPid();
    assert.ok(pid);
    rozone._test.enhanced.setIdleMinutes(0.03);
    await waitFor("the sidecar to stop", () => rozone._test.enhanced.sidecarPid() === undefined, 20_000);
    await waitFor(
      "the process to be gone",
      () => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      },
      10_000,
    );
    rozone._test.enhanced.setIdleMinutes(undefined);
    await appendText(await openFixture("enhanced", "live_edit.R"), "\n");
    await vscode.window.showTextDocument(await openFixture("enhanced", "live_edit.R"));
    await vscode.workspace.saveAll();
    await waitFor("the sidecar to restart on the next save", () => rozone._test.enhanced.sidecarPid() !== undefined, 30_000);
  });
});
