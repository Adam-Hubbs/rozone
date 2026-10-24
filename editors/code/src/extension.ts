import * as vscode from "vscode";
import { startBaseTier, type BaseTier } from "./base/index.ts";
import type { BaseTierApi } from "./enhanced/api.ts";
import { activateEnhanced, enhancedTestHooks } from "./enhanced/index.ts";

export interface RozoneExports {
  base: BaseTierApi;
  _test: {
    tier: BaseTier;
    injectedTopics(): ReadonlySet<string>;
    enhanced: typeof enhancedTestHooks;
  };
}

let tier: BaseTier | undefined;

export function activate(context: vscode.ExtensionContext): RozoneExports {
  const log = vscode.window.createOutputChannel("rozone", { log: true });
  context.subscriptions.push(log);

  const base = startBaseTier(context, log);
  tier = base;
  log.info(`base tier started (workspace trusted: ${vscode.workspace.isTrusted})`);

  context.subscriptions.push(
    vscode.commands.registerCommand("rozone.showOutput", () => log.show(true)),
    vscode.commands.registerCommand("rozone.openDocumentation", (name?: unknown, fromPath?: unknown) =>
      typeof name === "string"
        ? base.docPreview.open(name, typeof fromPath === "string" ? fromPath : undefined)
        : base.docPreview.openFromEditorOrPicker(),
    ),
  );

  try {
    context.subscriptions.push(activateEnhanced(context, base.api));
  } catch (error) {
    log.error(`enhanced tier failed to activate; staying in base tier: ${error instanceof Error ? error.message : String(error)}`);
  }

  return { base: base.api, _test: { tier: base, injectedTopics: base.injectedTopics, enhanced: enhancedTestHooks } };
}

export async function deactivate(): Promise<void> {
  const current = tier;
  tier = undefined;
  await current?.dispose();
}
