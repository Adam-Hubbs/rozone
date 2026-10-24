import assert from "node:assert/strict";
import { test } from "node:test";

import { examplePath, exampleText, fnv1a64, loadRozone, wmeanManifest } from "./helpers.ts";

const rozone = loadRozone();

const CORE_TODO = {};

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

test("a core panic surfaces as a JS error and the module stays usable", (t) => {
  const index = new rozone.RozoneIndex();
  try {
    index.updateFile(examplePath, exampleText);
  } catch (error) {
    assert.ok(error instanceof Error, "panic should throw a JS Error subclass");
    assert.notEqual(error.message, "");
    assert.equal(rozone.contentHash(""), "cbf29ce484222325", "module unusable after panic");
    const second = new rozone.RozoneIndex();
    assert.ok(second instanceof rozone.RozoneIndex);
    return;
  }
  t.skip("update_file no longer panics; panic-surfacing check not applicable");
});

test("hover on the wmean callee returns a static call hover", CORE_TODO, () => {
  const index = new rozone.RozoneIndex();
  index.updateFile(examplePath, exampleText);
  const hover = index.hover(examplePath, calleeOffset(exampleText) + 1);
  assert.ok(hover);
  assert.equal(hover.name, "wmean");
  assert.equal(hover.kind, "call");
  assert.equal(hover.source, "static");
  assert.match(hover.markdown, /Weighted mean/);
});

test("signatureHelp after `{{ col }}, ` has activeParameter 1", CORE_TODO, () => {
  const index = new rozone.RozoneIndex();
  index.updateFile(examplePath, exampleText);
  const offset = exampleText.indexOf("{{ col }}, w)") + "{{ col }}, ".length;
  const help = index.signatureHelp(examplePath, offset);
  assert.ok(help);
  assert.equal(help.name, "wmean");
  assert.equal(help.activeParameter, 1);
});

test("hover on an unknown function returns undefined", CORE_TODO, () => {
  const index = new rozone.RozoneIndex();
  index.updateFile("/tmp/unknown.R", "not_a_known_fn(1, 2)\n");
  assert.equal(index.hover("/tmp/unknown.R", 1), undefined);
});

test("loadManifest with invalid JSON throws", CORE_TODO, () => {
  const index = new rozone.RozoneIndex();
  assert.throws(() => index.loadManifest("{ not json"), /invalid manifest/);
});

test("loadManifest with a matching content hash switches source to manifest", CORE_TODO, () => {
  const index = new rozone.RozoneIndex();
  index.updateFile(examplePath, exampleText);
  index.loadManifest(JSON.stringify(wmeanManifest(examplePath, exampleText, rozone.contentHash)));
  const hover = index.hover(examplePath, calleeOffset(exampleText) + 1);
  assert.ok(hover);
  assert.equal(hover.source, "manifest");
});

test("documentedFunctions lists wmean and summarise_wmean", CORE_TODO, () => {
  const index = new rozone.RozoneIndex();
  index.updateFile(examplePath, exampleText);
  const names = index.documentedFunctions().map((fn) => fn.name);
  assert.ok(names.includes("wmean"), names.join(", "));
  assert.ok(names.includes("summarise_wmean"), names.join(", "));
});

test("UTF-16 offsets after an emoji in a comment still resolve", CORE_TODO, () => {
  const text = `# 🎉 emoji comment\n${exampleText}`;
  const index = new rozone.RozoneIndex();
  index.updateFile(examplePath, text);
  const start = calleeOffset(text);
  const hover = index.hover(examplePath, start + 1);
  assert.ok(hover);
  assert.equal(hover.name, "wmean");
  assert.deepEqual(hover.range, { start, end: start + "wmean".length });
});
