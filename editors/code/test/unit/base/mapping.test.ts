import assert from "node:assert/strict";
import { test } from "node:test";
import { shouldShowHover, toHoverModel, toSignatureModel } from "../../../src/base/mapping.ts";
import type { CoreHover, CoreSignatureHelp } from "../../../src/base/types.ts";

const hover = (overrides: Partial<CoreHover> = {}): CoreHover => ({
  name: "wmean",
  kind: "call",
  markdown: "**wmean**",
  range: { start: 10, end: 15 },
  source: "static",
  ...overrides,
});

const help = (overrides: Partial<CoreSignatureHelp> = {}): CoreSignatureHelp => ({
  name: "wmean",
  label: "wmean(x, w = rep(1, length(x)))",
  documentation: "Weighted mean",
  parameters: [
    { label: [6, 7], documentation: "A numeric vector." },
    { label: [9, 30], documentation: "Weights." },
  ],
  activeParameter: 1,
  source: "static",
  ...overrides,
});

test("hover dedupe skips only call sites of injected topics", () => {
  const injected = new Set(["wmean"]);
  assert.equal(shouldShowHover(hover({ kind: "call" }), injected), false);
  assert.equal(shouldShowHover(hover({ kind: "definition" }), injected), true);
  assert.equal(shouldShowHover(hover({ kind: "identifier" }), injected), true);
});

test("hover dedupe keeps call sites of functions that were not injected", () => {
  assert.equal(shouldShowHover(hover({ name: "other" }), new Set(["wmean"])), true);
  assert.equal(shouldShowHover(hover(), new Set()), true);
});

test("hover model keeps the markdown and the offset range", () => {
  assert.deepEqual(toHoverModel(hover()), { markdown: "**wmean**", range: { start: 10, end: 15 } });
});

test("signature model keeps labels as offset tuples and the active parameter", () => {
  const model = toSignatureModel(help());
  assert.equal(model.label, "wmean(x, w = rep(1, length(x)))");
  assert.deepEqual(model.parameters.map((p) => p.label), [[6, 7], [9, 30]]);
  assert.equal(model.activeParameter, 1);
  assert.equal(model.documentation, "Weighted mean");
});

test("an unmatched active parameter points past the end so nothing is highlighted", () => {
  assert.equal(toSignatureModel(help({ activeParameter: null })).activeParameter, 2);
  assert.equal(toSignatureModel(help({ activeParameter: 7 })).activeParameter, 2);
  assert.equal(toSignatureModel(help({ activeParameter: -1 })).activeParameter, 2);
});

test("parameter labels outside the signature label are neutralised", () => {
  const model = toSignatureModel(
    help({
      parameters: [
        { label: [0, 999], documentation: "too long" },
        { label: [5, 2], documentation: "backwards" },
        { label: [1.5, 3], documentation: "fractional" },
        { label: [0, 6], documentation: "fine" },
      ],
    }),
  );
  assert.deepEqual(model.parameters.map((p) => p.label), [[0, 0], [0, 0], [0, 0], [0, 6]]);
});

test("a signature without parameters has activeParameter 0", () => {
  const model = toSignatureModel(help({ label: "f()", parameters: [], activeParameter: null }));
  assert.equal(model.activeParameter, 0);
  assert.deepEqual(model.parameters, []);
});

test("non-ASCII labels use UTF-16 offsets unchanged", () => {
  const label = "größe(x, 你好 = 1)";
  const model = toSignatureModel(help({ label, parameters: [{ label: [6, 7], documentation: "" }, { label: [9, 15], documentation: "" }] }));
  assert.equal(label.slice(...model.parameters[0]!.label), "x");
  assert.equal(label.slice(...model.parameters[1]!.label), "你好 = 1");
});
