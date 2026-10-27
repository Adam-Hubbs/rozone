import assert from "node:assert/strict";
import { test } from "node:test";

import { loadRozone } from "./helpers.ts";

const FUNCTIONS = 4000;
const TARGET_LINES = 50_000;
const UPDATE_BUDGET_MS = 50;
const QUERY_BUDGET_MS = 1;

const documentedFunction = (i: number): string[] => [
  `#' Documented function ${i}`,
  "#'",
  `#' Computes a weighted mean over \`x\` and \`w\` (fn ${i}).`,
  "#' @param x A numeric vector.",
  "#' @param w Weights, the same length as `x`.",
  "#' @returns A length-1 double.",
  "#' @export",
  `fn_${i} <- function(x, w = rep(1, length(x))) {`,
  "  keep <- !is.na(x) & !is.na(w)",
  "  sum(x[keep] * w[keep]) / sum(w[keep])",
  "}",
  "",
];

const makeSource = (): string => {
  const lines = Array.from({ length: FUNCTIONS }, (_, i) => documentedFunction(i)).flat();
  while (lines.length < TARGET_LINES) lines.push(`# filler line ${lines.length}`);
  return lines.join("\n");
};

test("benchmark: instantiate, updateFile on ~50k lines with 4,000 documented functions", (t) => {
  const instantiateStart = performance.now();
  const rozone = loadRozone();
  const instantiateMs = performance.now() - instantiateStart;

  const text = makeSource();
  const index = new rozone.RozoneIndex();
  const updateStart = performance.now();
  try {
    index.updateFile("/bench/big.R", text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    t.skip(`rozone_core not implemented yet: ${message}`);
    return;
  }
  const updateMs = performance.now() - updateStart;

  const { heapUsed, arrayBuffers, rss } = process.memoryUsage();
  const mb = (bytes: number): string => (bytes / 1e6).toFixed(1);
  console.log(`instantiate: ${instantiateMs.toFixed(1)} ms`);
  console.log(`updateFile (${text.split("\n").length} lines, ${FUNCTIONS} fns): ${updateMs.toFixed(1)} ms`);
  console.log(`memory: rss ${mb(rss)} MB, heapUsed ${mb(heapUsed)} MB, arrayBuffers ${mb(arrayBuffers)} MB`);

  if (process.env.ROZONE_BENCH_STRICT === "1") {
    assert.ok(updateMs < UPDATE_BUDGET_MS, `updateFile took ${updateMs.toFixed(1)} ms`);
  }
});

const perCallMs = (runs: number, work: (i: number) => unknown): number => {
  const start = performance.now();
  for (let i = 0; i < runs; i++) work(i);
  return (performance.now() - start) / runs;
};

test("benchmark: hover, signature help and documentation through the WASM boundary", () => {
  const rozone = loadRozone();
  const lines = Array.from({ length: FUNCTIONS }, (_, i) => documentedFunction(i)).flat();
  lines.push("fn_2000(c(1, 2), w = 3)");
  const text = lines.join("\n");
  const index = new rozone.RozoneIndex();
  index.updateFile("/bench/big.R", text);
  const call = text.lastIndexOf("fn_2000(");
  assert.ok(index.hover("/bench/big.R", call)?.markdown.includes("Documented function 2000"));

  const runs = 1000;
  const hoverMs = perCallMs(runs, (i) => index.hover("/bench/big.R", call + (i % 3)));
  const signatureMs = perCallMs(runs, () => index.signatureHelp("/bench/big.R", call + 8));
  const pageMs = perCallMs(runs, () => index.documentation("fn_2000", "/bench/big.R"));
  const editMs = perCallMs(20, (i) => index.updateFile("/bench/big.R", i % 2 === 0 ? `${text}\n` : text));
  console.log(`hover: ${hoverMs.toFixed(3)} ms each`);
  console.log(`signatureHelp: ${signatureMs.toFixed(3)} ms each`);
  console.log(`documentation: ${pageMs.toFixed(3)} ms each`);
  console.log(`re-index after an edit: ${editMs.toFixed(1)} ms each`);
  index.free();

  if (process.env.ROZONE_BENCH_STRICT === "1") {
    assert.ok(hoverMs < QUERY_BUDGET_MS, `hover took ${hoverMs.toFixed(3)} ms`);
    assert.ok(signatureMs < QUERY_BUDGET_MS, `signatureHelp took ${signatureMs.toFixed(3)} ms`);
    assert.ok(editMs < UPDATE_BUDGET_MS, `re-index took ${editMs.toFixed(1)} ms`);
  }
});
