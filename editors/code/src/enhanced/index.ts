import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ActivateEnhanced, BaseTierApi } from "./api.ts";
import { LibStore } from "./libStore.ts";
import { SidecarController, type ViewState } from "./lifecycle.ts";
import { PositronInjector } from "./positronInjector.ts";
import { createPositronBridge, tryAcquirePositronApi } from "./positronApi.ts";
import { LaunchResolver } from "./rDiscovery.ts";
import { SidecarClient } from "./sidecarClient.ts";
import { describeState } from "./statusModel.ts";

// Read-only window into the running tier for the integration tests, exposed through the extension API `_test`.
let testIdleMinutes: number | undefined;
let testState: ViewState | undefined;
let testClient: SidecarClient | undefined;
let testRearmIdle: (() => void) | undefined;

export const enhancedTestHooks = {
  state: (): ViewState | undefined => testState,
  sidecarPid: (): number | undefined => testClient?.pid,
  setIdleMinutes(minutes: number | undefined): void {
    testIdleMinutes = minutes;
    testRearmIdle?.();
  },
};

const SHOW_LOG_COMMAND = "rozone.enhanced.showLog";

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function isVirtualWorkspace(): boolean {
  const folders = vscode.workspace.workspaceFolders ?? [];
  return folders.length > 0 && folders.every((f) => f.uri.scheme !== "file");
}

export const activateEnhanced: ActivateEnhanced = (context, base: BaseTierApi) => {
  const config = () => vscode.workspace.getConfiguration("rozone");
  const positronApi = tryAcquirePositronApi();
  const bridge = positronApi ? createPositronBridge(positronApi) : undefined;
  const sidecarScript = path.join(context.extensionPath, "r", "sidecar.R");
  const storageRoot = context.storageUri?.fsPath ?? path.join(context.globalStorageUri.fsPath, "no-workspace");
  const store = new LibStore(storageRoot, base.log);

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 0);
  status.command = SHOW_LOG_COMMAND;
  status.show();

  const resolver = new LaunchResolver({
    platform: process.platform,
    isFile,
    pathEnv: process.env["PATH"],
    baseEnv: process.env,
    settingPath: () => config().get<string>("r.path", ""),
    sidecarScript,
    positron: bridge,
    log: base.log,
  });

  let controller: SidecarController | undefined;
  const injector = bridge
    ? new PositronInjector({
        bridge,
        store,
        log: base.log,
        requestBuild: () => controller?.requestBuild(),
        setInjectedTopics: (names) => base.setInjectedTopics(names),
        onActiveChange: () => controller?.updateState(),
      })
    : undefined;

  controller = new SidecarController({
    base,
    log: base.log,
    env: {
      isTrusted: () => vscode.workspace.isTrusted,
      isVirtual: isVirtualWorkspace,
      isPositron: bridge !== undefined,
    },
    config: {
      enabled: () => config().get<boolean>("enhanced.enabled", true),
      idleMinutes: () => testIdleMinutes ?? config().get<number>("sidecar.idleTimeoutMinutes", 10),
      helpInjection: () => config().get<boolean>("helpInjection", true),
    },
    resolveLaunch: () => resolver.resolve(),
    resetLaunch: () => resolver.reset(),
    createClient: (spec) => {
      const cwd = vscode.workspace.workspaceFolders?.find((f) => f.uri.scheme === "file")?.uri.fsPath;
      testClient = new SidecarClient({ ...spec, cwd, log: base.log });
      return testClient;
    },
    readFile: (file) => fs.promises.readFile(file, "utf8"),
    injector,
    notifyRoxygenMissing: () => {
      void vscode.window.showInformationMessage("Install roxygen2 for richer docs");
    },
    onState: (state) => {
      testState = state;
      const view = describeState(state);
      status.text = view.text;
      status.tooltip = view.tooltip;
    },
  });
  const live = controller;
  live.updateState();
  testRearmIdle = () => live.rearmIdle();

  const subscriptions: vscode.Disposable[] = [
    status,
    vscode.commands.registerCommand(SHOW_LOG_COMMAND, () => base.log.show(true)),
    vscode.commands.registerCommand("rozone.restartSidecar", () => live.restart()),
    base.onDidSaveRFile(() => live.requestBuild()),
    vscode.workspace.onDidGrantWorkspaceTrust(() => void live.refresh()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration("rozone.enhanced.enabled") ||
        e.affectsConfiguration("rozone.r.path") ||
        e.affectsConfiguration("rozone.helpInjection")
      ) {
        void live.reconfigure();
      } else if (e.affectsConfiguration("rozone.sidecar.idleTimeoutMinutes")) {
        live.rearmIdle();
      }
    }),
  ];

  void (base.ready ?? Promise.resolve()).then(() => live.refresh());

  if (bridge) {
    void (base.ready ?? Promise.resolve())
      .then(async () => {
        const now = Date.now();
        await store.sweep(await bridge.activeSessionIds(), now);
        await store.cleanLegacy(context.globalStorageUri.fsPath, now);
      })
      .catch((error: unknown) => base.log.warn(`startup cleanup failed: ${String(error)}`));
  }

  return new vscode.Disposable(() => {
    live.dispose();
    injector?.dispose();
    for (const s of subscriptions) s.dispose();
  });
};
