import assert from "node:assert/strict";
import { test } from "node:test";

import { examplePath, exampleText, fnv1a64, loadRozone, wmeanManifest } from "./helpers.ts";

const rozone = loadRozone();

const calleeOffset = (text: string): number => text.indexOf("wmean({{ col }}, w)");

test("contentHash of the empty string is the FNV-1a offset basis", () => {
  assert.equal(rozone.contentHash(""), "cbf29ce484222325");
});

test("contentHash matches an independent FNV-1a 64 over UTF-8 bytes", () => {
  for (const text of ["hello", "héllo wörld 🎉 日本語", "# wmean <- function(x) x\n"]) {
    assert.equal(rozone.contentHash(text), fnv1a64(text), JSON.stringify(text));
  }
});

test("version returns a semver string", () => {
  assert.match(rozone.version(), /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
});

test("RozoneIndex constructs and frees", () => {
  const index = new rozone.RozoneIndex();
  assert.ok(index instanceof rozone.RozoneIndex);
  index.free();
});

test("hover on the wmean callee returns a static call hover", () => {
  const index = new rozone.RozoneIndex();
  index.updateFile(examplePath, exampleText);
  const hover = index.hover(examplePath, calleeOffset(exampleText) + 1);
  assert.ok(hover);
  assert.equal(hover.name, "wmean");
  assert.equal(hover.kind, "call");
  assert.equal(hover.source, "static");
  assert.match(hover.markdown, /Weighted mean of a column/);
  assert.match(hover.markdown, /Weights, the same length as `x`\./);
});

test("signatureHelp after `{{ col }}, ` has activeParameter 1", () => {
  const index = new rozone.RozoneIndex();
  index.updateFile(examplePath, exampleText);
  const offset = exampleText.indexOf("{{ col }}, w)") + "{{ col }}, ".length;
  const help = index.signatureHelp(examplePath, offset);
  assert.ok(help);
  assert.equal(help.name, "wmean");
  assert.equal(help.activeParameter, 1);
});

test("hover on an unknown function returns undefined", () => {
  const index = new rozone.RozoneIndex();
  index.updateFile("/tmp/unknown.R", "not_a_known_fn(1, 2)\n");
  assert.equal(index.hover("/tmp/unknown.R", 1), undefined);
});

test("loadManifest with invalid JSON throws", () => {
  const index = new rozone.RozoneIndex();
  assert.throws(() => index.loadManifest("{ not json"), /invalid manifest/);
});

test("loadManifest with a matching content hash switches source to manifest", () => {
  const index = new rozone.RozoneIndex();
  index.updateFile(examplePath, exampleText);
  index.loadManifest(JSON.stringify(wmeanManifest(examplePath, exampleText, rozone.contentHash)));
  const hover = index.hover(examplePath, calleeOffset(exampleText) + 1);
  assert.ok(hover);
  assert.equal(hover.source, "manifest");
});

test("documentedFunctions lists wmean and summarise_wmean", () => {
  const index = new rozone.RozoneIndex();
  index.updateFile(examplePath, exampleText);
  const names = index.documentedFunctions().map((fn) => fn.name);
  assert.ok(names.includes("wmean"), names.join(", "));
  assert.ok(names.includes("summarise_wmean"), names.join(", "));
});

test("UTF-16 offsets after an emoji in a comment still resolve", () => {
  const text = `# 🎉 emoji comment\n${exampleText}`;
  const index = new rozone.RozoneIndex();
  index.updateFile(examplePath, text);
  const start = calleeOffset(text);
  const hover = index.hover(examplePath, start + 1);
  assert.ok(hover);
  assert.equal(hover.name, "wmean");
  assert.deepEqual(hover.range, { start, end: start + "wmean".length });
});

test("documentation returns the same page the hover shows, with usage and examples", () => {
  const index = new rozone.RozoneIndex();
  index.updateFile(examplePath, exampleText);
  const page = index.documentation("wmean", examplePath);
  assert.ok(page);
  assert.match(page, /Weighted mean of a column/);
  assert.match(page, /wmean\(x, w = rep\(1, length\(x\)\)\)/);
  assert.match(page, /wmean\(1:3, c\(1, 1, 2\)\)/);
  assert.equal(index.documentation("not_a_known_fn", examplePath), undefined);
});

test("removeFile drops a file's docs from hover and documentedFunctions", () => {
  const index = new rozone.RozoneIndex();
  index.updateFile(examplePath, exampleText);
  index.removeFile(examplePath);
  assert.equal(index.hover(examplePath, calleeOffset(exampleText) + 1), undefined);
  assert.deepEqual(index.documentedFunctions(), []);
});
