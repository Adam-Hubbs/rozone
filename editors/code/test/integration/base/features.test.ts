import assert from "node:assert/strict";
import * as vscode from "vscode";
import type { RozoneExports } from "../../../src/extension.ts";
import {
  activateRozone,
  appendText,
  fixture,
  fsPathOf,
  hoversAt,
  hoverText,
  isPositron,
  openFixture,
  openProbe,
  openUntitled,
  positionOf,
  resetEditors,
  signatureAt,
  waitFor,
  waitForIndexed,
  waitForInitialIndex,
} from "../support.ts";

let rozone: RozoneExports;

suiteSetup(async () => {
  rozone = await activateRozone();
  await waitForInitialIndex(rozone);
});

teardown(async () => {
  rozone._test.tier.api.setInjectedTopics(new Set());
  await resetEditors();
});

suite("hover", () => {
  test("a call site shows the function's docs", async () => {
    const doc = await openFixture("example_script.R");
    const hovers = await hoversAt(doc, positionOf(doc, "wmean({{", 2));
    assert.ok(hovers.length > 0, "expected a hover from rozone");
    assert.match(hoverText(hovers), /weighted mean/i);
  });

  test("the hover range covers exactly the identifier", async () => {
    const doc = await openFixture("example_script.R");
    const hovers = await hoversAt(doc, positionOf(doc, "wmean({{", 2));
    const range = hovers[0]?.range;
    assert.ok(range);
    assert.equal(doc.getText(range), "wmean");
  });

  test("a definition shows docs", async () => {
    const doc = await openFixture("example_script.R");
    const hovers = await hoversAt(doc, positionOf(doc, "wmean <- function", 1));
    assert.match(hoverText(hovers), /weighted mean/i);
  });

  test("unknown functions return nothing from rozone", async function () {
    const doc = await openFixture("example_script.R");
    const hovers = await hoversAt(doc, positionOf(doc, "summarise(data", 2));
    const text = hoverText(hovers);
    if (!isPositron()) assert.equal(hovers.length, 0, `unexpected hover: ${text}`);
    assert.doesNotMatch(text, /Weighted mean|wmean/);
  });

  test("whitespace and comments return nothing", async () => {
    const doc = await openFixture("example_script.R");
    assert.equal((await hoversAt(doc, positionOf(doc, "library(dplyr)", 20))).length, 0);
    assert.equal((await hoversAt(doc, positionOf(doc, "Computes a weighted", 3))).length, 0);
  });

  test("a function documented in another file resolves across files", async () => {
    const doc = await openFixture("inherit", "child.R");
    const hovers = await hoversAt(doc, positionOf(doc, "scale_by(x, factor)", 2));
    assert.match(hoverText(hovers), /Scale a vector/);
  });

  test("a file broken in the middle still documents its working functions", async () => {
    const doc = await openFixture("broken.R");
    const hovers = await hoversAt(doc, positionOf(doc, "survivor(1)", 2));
    assert.match(hoverText(hovers), /Survives a broken neighbour/);
  });

  test("offsets stay correct after non-ASCII text and astral characters", async () => {
    const doc = await openFixture("unicode.R");
    const hovers = await hoversAt(doc, positionOf(doc, 'grosse(1, "é")', 3));
    assert.ok(hovers.length > 0);
    assert.equal(doc.getText(hovers[0]?.range), "grosse");
    assert.match(hoverText(hovers), /Größe/);
  });

  test("hover is skipped for call sites of injected topics but not definitions", async () => {
    const doc = await openFixture("example_script.R");
    rozone._test.tier.api.setInjectedTopics(new Set(["wmean"]));
    assert.equal((await hoversAt(doc, positionOf(doc, "wmean({{", 2))).length, 0);
    assert.match(hoverText(await hoversAt(doc, positionOf(doc, "wmean <- function", 1))), /weighted mean/i);
    rozone._test.tier.api.setInjectedTopics(new Set());
    assert.ok((await hoversAt(doc, positionOf(doc, "wmean({{", 2))).length > 0);
  });

  test("hover content is not trusted and has no HTML", async () => {
    const doc = await openFixture("example_script.R");
    const hovers = await hoversAt(doc, positionOf(doc, "wmean({{", 2));
    for (const content of hovers.flatMap((hover) => hover.contents)) {
      if (typeof content === "string" || !("isTrusted" in content)) continue;
      assert.ok(!content.isTrusted, "markdown must not be trusted");
      assert.ok(!content.supportHtml, "markdown must not allow HTML");
    }
  });
});

suite("signature help", () => {
  test("shows the signature with parameter docs and the first parameter active", async () => {
    const doc = await openFixture("example_script.R");
    const help = await signatureAt(doc, positionOf(doc, "wmean({{", 6), "(");
    assert.ok(help, "expected signature help");
    const signature = help.signatures[0];
    assert.ok(signature?.label.startsWith("wmean("));
    assert.equal(signature.parameters.length, 2);
    assert.equal(help.activeParameter, 0);
    const [start, end] = signature.parameters[0]?.label as [number, number];
    assert.equal(signature.label.slice(start, end), "x");
  });

  test("the active parameter follows the comma", async () => {
    const doc = await openFixture("example_script.R");
    const help = await signatureAt(doc, positionOf(doc, "{{ col }}, w", "{{ col }}, ".length), ",");
    assert.ok(help);
    assert.equal(help.activeParameter, 1);
    const parameter = help.signatures[0]?.parameters[1];
    assert.match(String(typeof parameter?.documentation === "string" ? parameter.documentation : parameter?.documentation?.value), /Weights/);
  });

  test("unknown functions return nothing from rozone", async () => {
    const doc = await openFixture("example_script.R");
    const help = await signatureAt(doc, positionOf(doc, "summarise(data", "summarise(".length), "(");
    if (!isPositron()) assert.equal(help, undefined);
    else assert.ok(!help?.signatures.some((signature) => signature.label.startsWith("wmean(")));
  });

  test("inherited parameter docs resolve across files", async () => {
    const doc = await openFixture("inherit", "child.R");
    const help = await signatureAt(doc, positionOf(doc, "scale_shift(1:3", "scale_shift(".length), "(");
    assert.ok(help);
    const docs = help.signatures[0]?.parameters.map((p) => (typeof p.documentation === "string" ? p.documentation : p.documentation?.value)).join("\n");
    assert.match(docs ?? "", /Multiplier/);
  });

  test("labels use UTF-16 offsets for non-ASCII parameters", async () => {
    const doc = await openFixture("unicode.R");
    const help = await signatureAt(doc, positionOf(doc, 'grosse(1, "é")', 'grosse(1, '.length), ",");
    assert.ok(help);
    assert.equal(help.activeParameter, 1);
    const signature = help.signatures[0];
    const [start, end] = signature?.parameters[1]?.label as [number, number];
    assert.match(signature?.label.slice(start, end) ?? "", /^名前/);
  });

  test("re-registering the provider keeps signature help working", async () => {
    rozone._test.tier.signatureHelp.reregister();
    const doc = await openFixture("example_script.R");
    const help = await signatureAt(doc, positionOf(doc, "wmean({{", 6), "(");
    assert.ok(help);
    assert.equal(help.signatures.filter((s) => s.label.startsWith("wmean(")).length, 1, "old registration was disposed");
  });
});

suite("live edits", () => {
  test("unsaved edits to an open document are reflected immediately", async () => {
    const doc = await openFixture("example_script.R");
    await vscode.window.showTextDocument(doc);
    await appendText(doc, "\n#' Brand new live function\n#'\n#' @param q The q.\nlive_fn <- function(q) q\nlive_fn(1)\n");
    assert.ok(doc.isDirty);
    const hovers = await hoversAt(doc, positionOf(doc, "live_fn(1)", 2));
    assert.match(hoverText(hovers), /Brand new live function/);
    const help = await signatureAt(doc, positionOf(doc, "live_fn(1)", "live_fn(".length), "(");
    assert.equal(help?.signatures[0]?.label.startsWith("live_fn("), true);
  });

  test("editing a roxygen line changes the next hover without saving", async () => {
    const doc = await openFixture("example_script.R");
    await vscode.window.showTextDocument(doc);
    const at = positionOf(doc, "Weighted mean of a column");
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, new vscode.Range(at, at.translate(0, "Weighted mean of a column".length)), "Totally different title");
    await vscode.workspace.applyEdit(edit);
    const hovers = await hoversAt(doc, positionOf(doc, "wmean({{", 2));
    assert.match(hoverText(hovers), /Totally different title/);
    assert.doesNotMatch(hoverText(hovers), /Weighted mean of a column/);
  });

  test("a live function in an open document is visible from other documents", async () => {
    const doc = await openFixture("inherit", "base.R");
    await vscode.window.showTextDocument(doc);
    await appendText(doc, "\n#' Only live\n#'\n#' @param a A.\nonly_live <- function(a) a\n");
    const other = await openProbe("only_live(1)\n");
    const hovers = await hoversAt(other, new vscode.Position(0, 3));
    assert.match(hoverText(hovers), /Only live/);
  });

  test("reverting a dirty document and closing it re-reads the disk", async () => {
    const doc = await openFixture("inherit", "base.R");
    await vscode.window.showTextDocument(doc);
    await appendText(doc, "\n#' Ghost\n#'\n#' @param a A.\nghost_fn <- function(a) a\n");
    const probe = await openProbe("ghost_fn(1)\n");
    assert.match(hoverText(await hoversAt(probe, new vscode.Position(0, 3))), /Ghost/);

    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand("workbench.action.files.revert");
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    await waitFor("ghost_fn to disappear after revert", async () => (await hoversAt(probe, new vscode.Position(0, 3))).length === 0);
  });
});

suite("untitled documents", () => {
  setup(async function () {
    const probe = await openUntitled("");
    if (probe.languageId !== "r") this.skip();
  });

  test("are indexed while open and excluded from indexedFiles()", async () => {
    const doc = await openUntitled("#' Scratch fn\n#'\n#' @param a A.\nscratch_fn <- function(a) a\nscratch_fn(1)\n");
    const hovers = await hoversAt(doc, positionOf(doc, "scratch_fn(1)", 3));
    assert.match(hoverText(hovers), /Scratch fn/);
    assert.ok(!rozone.base.indexedFiles().some((file) => file.startsWith("untitled:")));
    assert.ok(rozone._test.tier.discovery.isIndexed(doc.uri.toString()));
  });

  test("can call functions defined in workspace files", async () => {
    const doc = await openUntitled("scale_by(1:3)\n");
    assert.match(hoverText(await hoversAt(doc, new vscode.Position(0, 3))), /Scale a vector/);
    const help = await signatureAt(doc, new vscode.Position(0, "scale_by(".length), "(");
    assert.equal(help?.signatures[0]?.label.startsWith("scale_by("), true);
  });

  test("closing removes them from the index", async () => {
    const doc = await openUntitled("#' Gone soon\n#'\n#' @param a A.\ngone_soon <- function(a) a\n");
    const probe = await openProbe("gone_soon(1)\n");
    assert.match(hoverText(await hoversAt(probe, new vscode.Position(0, 3))), /Gone soon/);
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
    await waitFor("untitled doc to leave the index", async () => (await hoversAt(probe, new vscode.Position(0, 3))).length === 0);
  });
});

suite("workspace files", () => {
  test("file create, change and delete update the index", async () => {
    const uri = fixture("created_later.R");
    const path = fsPathOf("created_later.R");
    const probe = await openProbe("created_later_fn(1)\n");
    const probeHover = () => hoversAt(probe, new vscode.Position(0, 3));

    await vscode.workspace.fs.writeFile(uri, Buffer.from("#' First text\n#'\n#' @param a A.\ncreated_later_fn <- function(a) a\n"));
    await waitForIndexed(rozone, path);
    await waitFor("created docs", async () => /First text/.test(hoverText(await probeHover())));

    await vscode.workspace.fs.writeFile(uri, Buffer.from("#' Second text\n#'\n#' @param a A.\ncreated_later_fn <- function(a) a\n"));
    await waitFor("changed docs", async () => /Second text/.test(hoverText(await probeHover())));

    await vscode.workspace.fs.delete(uri);
    await waitFor("removal from indexedFiles", () => !rozone.base.indexedFiles().includes(path));
    await waitFor("docs to disappear", async () => (await probeHover()).length === 0);
  });

  test("the initial scan indexed the fixtures, honouring excludes and the size limit", () => {
    const files = rozone.base.indexedFiles();
    for (const expected of ["example_script.R", "unicode.R", "broken.R", "inherit/base.R", "inherit/child.R", "generated/large.R"]) {
      assert.ok(files.includes(fsPathOf(expected)), `${expected} should be indexed`);
    }
    assert.ok(!files.includes(fsPathOf("renv", "hidden.R")), "renv is excluded by default");
    assert.ok(!files.includes(fsPathOf("generated", "too_big.R")), "files over 5 MB are skipped");
  });

  test("excluded files are not documented", async () => {
    const doc = await openProbe("hidden_fn(1)\n");
    assert.equal((await hoversAt(doc, new vscode.Position(0, 3))).length, 0);
  });

  test("contentHash matches the contract and invalid manifests are rejected", async () => {
    assert.equal(await rozone.base.contentHash(""), "cbf29ce484222325");
    await assert.rejects(rozone.base.loadManifest("not json"));
    await rozone.base.clearManifest();
  });

  test("saving an indexed file fires onDidSaveRFile", async () => {
    const doc = await openFixture("inherit", "base.R");
    await vscode.window.showTextDocument(doc);
    const saved = new Promise<vscode.Uri>((resolve) => {
      const subscription = rozone.base.onDidSaveRFile((uri) => {
        subscription.dispose();
        resolve(uri);
      });
    });
    await appendText(doc, "\n");
    await doc.save();
    assert.equal((await saved).fsPath, doc.uri.fsPath);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, new vscode.Range(doc.lineCount - 1, 0, doc.lineCount, 0), "");
    await vscode.workspace.applyEdit(edit);
    await doc.save();
  });
});

suite("open documentation", () => {
  test("renders the function's markdown in the preview", async () => {
    const uri = (await vscode.commands.executeCommand("rozone.openDocumentation", "wmean")) as vscode.Uri | undefined;
    assert.equal(uri?.scheme, "rozone-doc");
    const doc = await vscode.workspace.openTextDocument(uri as vscode.Uri);
    assert.match(doc.getText(), /wmean/);
    await waitFor("a markdown preview tab", () =>
      vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .some((tab) => tab.input instanceof vscode.TabInputWebview && tab.input.viewType.includes("markdown.preview")),
    );
  });

  test("uses the function under the cursor when no name is given", async () => {
    const doc = await openFixture("example_script.R");
    const editor = await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(positionOf(doc, "wmean({{", 2), positionOf(doc, "wmean({{", 2));
    const uri = (await vscode.commands.executeCommand("rozone.openDocumentation")) as vscode.Uri | undefined;
    assert.equal(uri?.scheme, "rozone-doc");
    assert.match(uri?.path ?? "", /wmean/);
  });
});

suite("latency", () => {
  test("hover and signature help answer in under 50 ms once indexed", async () => {
    const doc = await openFixture("example_script.R");
    const large = await openFixture("generated", "large.R");
    const targets = [
      { doc, hover: positionOf(doc, "wmean({{", 2), sig: positionOf(doc, "wmean({{", 6), label: "example_script.R" },
      { doc: large, hover: positionOf(large, "generated_fn_3999(1)", 3), sig: positionOf(large, "generated_fn_3999(1)", "generated_fn_3999(".length), label: "large.R (4000 functions)" },
    ];
    for (const target of targets) {
      for (let i = 0; i < 5; i++) {
        await hoversAt(target.doc, target.hover);
        await signatureAt(target.doc, target.sig, "(");
      }
      const hoverTimes: number[] = [];
      const sigTimes: number[] = [];
      for (let i = 0; i < 40; i++) {
        let started = performance.now();
        const hovers = await hoversAt(target.doc, target.hover);
        hoverTimes.push(performance.now() - started);
        started = performance.now();
        const help = await signatureAt(target.doc, target.sig, "(");
        sigTimes.push(performance.now() - started);
        assert.ok(hovers.length > 0 && help, `${target.label}: expected results`);
      }
      const median = (values: number[]) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)] as number;
      const p95 = (values: number[]) => values.toSorted((a, b) => a - b)[Math.floor(values.length * 0.95)] as number;
      console.log(
        `latency ${target.label}: hover median ${median(hoverTimes).toFixed(1)} ms p95 ${p95(hoverTimes).toFixed(1)} ms; ` +
          `signature median ${median(sigTimes).toFixed(1)} ms p95 ${p95(sigTimes).toFixed(1)} ms (includes extension host command round trip)`,
      );
      assert.ok(median(hoverTimes) < 50, `${target.label}: hover median ${median(hoverTimes)} ms`);
      assert.ok(median(sigTimes) < 50, `${target.label}: signature median ${median(sigTimes)} ms`);
      assert.ok(p95(hoverTimes) < 50, `${target.label}: hover p95 ${p95(hoverTimes)} ms`);
      assert.ok(p95(sigTimes) < 50, `${target.label}: signature p95 ${p95(sigTimes)} ms`);
    }
  });
});
