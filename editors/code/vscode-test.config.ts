import { defineConfig } from "@vscode/test-cli";
import { downloadAndUnzipVSCode } from "@vscode/test-electron";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const scratch = join(root, ".vscode-test");
const positronExecutable = "/Applications/Positron.app/Contents/MacOS/Positron";
const usePositron = process.env.ROZONE_TEST_POSITRON === "1";
const version = process.env.ROZONE_VSCODE_VERSION ?? "1.100.0";

const realExecutable = usePositron ? positronExecutable : await downloadAndUnzipVSCode(version);

const MB = 1024 * 1024;

function functionBlock(index: number): string {
  return `#' Generated function ${index}\n#'\n#' @param x Input ${index}.\n#' @param y Second input ${index}.\ngenerated_fn_${index} <- function(x, y = ${index}) {\n  x + y\n}\n\n`;
}

function prepareWorkspace(name: string): string {
  const target = join(scratch, "workspaces", name);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(dirname(target), { recursive: true });
  cpSync(join(root, "test", "fixtures", "workspace"), target, { recursive: true });
  mkdirSync(join(target, "generated"), { recursive: true });
  const large = Array.from({ length: 4000 }, (_, i) => functionBlock(i)).join("");
  writeFileSync(join(target, "generated", "large.R"), `${large}generated_fn_3999(1)\n`);
  writeFileSync(join(target, "generated", "too_big.R"), `# ${"x".repeat(6 * MB)}\n#' Huge\ntoo_big_fn <- function(a) a\n`);
  return target;
}

function prepareUserData(name: string, settings: Record<string, unknown>): string {
  const target = join(tmpdir(), `rozone-vt-${name}`);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(join(target, "User"), { recursive: true });
  writeFileSync(
    join(target, "User", "settings.json"),
    JSON.stringify({
      "telemetry.telemetryLevel": "off",
      "update.mode": "none",
      "extensions.autoUpdate": false,
      "window.restoreWindows": "none",
      "workbench.startupEditor": "none",
      ...settings,
    }),
  );
  return target;
}

const common = {
  version,
  extensionDevelopmentPath: root,
  launchArgs: ["--disable-extension=vscode.git", "--disable-extension=vscode.github", "--disable-gpu"],
} as const;

const spy = join(root, "dist", "test", "test", "integration", "spawnSpy.setup.cjs");
const suites = (...names: string[]) => names.map((name) => `dist/test/test/integration/${name}/*.test.cjs`);

export default defineConfig([
  {
    ...common,
    label: "trusted",
    files: suites("base", "trusted"),
    workspaceFolder: prepareWorkspace("trusted"),
    launchArgs: [...common.launchArgs, `--user-data-dir=${prepareUserData("trusted", {})}`],
    useInstallation: { fromPath: realExecutable },
    mocha: { ui: "tdd", timeout: 60_000, require: [spy] },
  },
  {
    ...common,
    label: "untrusted",
    files: suites("base", "untrusted"),
    workspaceFolder: prepareWorkspace("untrusted"),
    launchArgs: [
      ...common.launchArgs,
      `--user-data-dir=${prepareUserData("untrusted", {
        "security.workspace.trust.enabled": true,
        "security.workspace.trust.startupPrompt": "never",
        "security.workspace.trust.banner": "never",
        "security.workspace.trust.emptyWindow": false,
      })}`,
    ],
    useInstallation: { fromPath: join(root, "scripts", `untrusted-launcher.${process.platform === "win32" ? "cmd" : "ts"}`) },
    env: { ROZONE_REAL_EXECUTABLE: realExecutable },
    mocha: { ui: "tdd", timeout: 60_000, require: [spy] },
  },
]);
