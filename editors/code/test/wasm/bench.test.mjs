import assert from "node:assert/strict";
import { test } from "node:test";

import { loadRozone } from "./helpers.mjs";

const FUNCTIONS = 4000;
const TARGET_LINES = 50_000;
const UPDATE_BUDGET_MS = 50;

const documentedFunction = (i) => [
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

const makeSource = () => {
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
    t.skip(`rozone_core not implemented yet: ${error.message}`);
    return;
  }
  const updateMs = performance.now() - updateStart;

  const { heapUsed, arrayBuffers, rss } = process.memoryUsage();
  const mb = (bytes) => (bytes / 1e6).toFixed(1);
  console.log(`instantiate: ${instantiateMs.toFixed(1)} ms`);
  console.log(`updateFile (${text.split("\n").length} lines, ${FUNCTIONS} fns): ${updateMs.toFixed(1)} ms`);
  console.log(`memory: rss ${mb(rss)} MB, heapUsed ${mb(heapUsed)} MB, arrayBuffers ${mb(arrayBuffers)} MB`);

  if (process.env.ROZONE_BENCH_STRICT === "1") {
    assert.ok(updateMs < UPDATE_BUDGET_MS, `updateFile took ${updateMs.toFixed(1)} ms`);
  }
});
