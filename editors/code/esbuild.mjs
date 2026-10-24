import * as esbuild from "esbuild";
import { cpSync, existsSync, globSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

const common = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  sourcemap: !production,
  minify: production,
  logLevel: "info",
  absWorkingDir: root,
};

// The wasm-pack nodejs output is loaded at run time from dist/wasm so the same layout works in dev and in the VSIX.
function copyWasm() {
  const source = join(root, "wasm");
  const target = join(root, "dist", "wasm");
  if (!existsSync(join(source, "rozone_wasm.js"))) {
    console.warn("warning: wasm/ is missing; run `npm run build:wasm`. The extension will start without an index.");
    return;
  }
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  for (const file of ["rozone_wasm.js", "rozone_wasm_bg.wasm"]) cpSync(join(source, file), join(target, file));
  writeFileSync(join(target, "package.json"), `${JSON.stringify({ private: true, type: "commonjs" })}\n`);
}

const builds = [
  {
    ...common,
    entryPoints: { extension: "src/extension.ts" },
    outdir: "dist",
    outExtension: { ".js": ".cjs" },
    external: ["vscode"],
  },
  {
    ...common,
    entryPoints: { worker: "src/base/worker.ts" },
    outdir: "dist",
    outExtension: { ".js": ".cjs" },
  },
  ...(production ? [] : [{
    ...common,
    sourcemap: true,
    minify: false,
    entryPoints: Object.fromEntries(
      [...globSync("test/integration/**/*.ts", { cwd: root }), ...globSync("test/helpers/**/*.ts", { cwd: root })].map((file) => [
        file.replace(/\.ts$/, ""),
        file,
      ]),
    ),
    outdir: "dist/test",
    outExtension: { ".js": ".cjs" },
    external: ["vscode", "mocha"],
  }]),
];

copyWasm();

if (watch) {
  const contexts = await Promise.all(builds.map((options) => esbuild.context(options)));
  await Promise.all(contexts.map((context) => context.watch()));
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
}
