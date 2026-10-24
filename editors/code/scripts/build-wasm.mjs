import { spawnSync } from "node:child_process";
import { rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const crateDir = resolve(scriptDir, "../../../crates/rozone_wasm");
const outDir = resolve(scriptDir, "../wasm");
const outName = "rozone_wasm";
const wasmPath = join(outDir, `${outName}_bg.wasm`);
const dev = process.argv.includes("--dev");

const run = (command, args) => {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
};

const hasWasmOpt = spawnSync("wasm-opt", ["--version"], { stdio: "ignore" }).status === 0;
const kib = (path) => `${(statSync(path).size / 1024).toFixed(1)} KiB`;

run("wasm-pack", [
  "build",
  crateDir,
  "--target",
  "nodejs",
  dev ? "--dev" : "--release",
  "--out-dir",
  outDir,
  "--out-name",
  outName,
]);

for (const generated of [".gitignore", "package.json", "README.md"]) {
  rmSync(join(outDir, generated), { force: true });
}
// The extension's package.json is "type": "module", but wasm-pack's nodejs output is CommonJS.
writeFileSync(join(outDir, "package.json"), `${JSON.stringify({ private: true, type: "commonjs" }, null, 2)}\n`);

if (dev) {
  console.log(`dev build: ${wasmPath} (${kib(wasmPath)}), wasm-opt skipped`);
} else if (hasWasmOpt) {
  const before = kib(wasmPath);
  run("wasm-opt", ["-Oz", wasmPath, "-o", wasmPath]);
  console.log(`wasm-opt -Oz: ${before} -> ${kib(wasmPath)}`);
} else {
  console.warn("warning: wasm-opt not found on PATH; skipping size optimisation");
  console.log(`wasm size: ${kib(wasmPath)}`);
}
