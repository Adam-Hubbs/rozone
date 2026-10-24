import * as vscode from "vscode";
import type { Discovery } from "./discovery.ts";
import type { IndexClient } from "./indexClient.ts";
import { pathKey } from "./paths.ts";

export const DOC_SCHEME = "rozone-doc";

export interface DocPreview extends vscode.Disposable {
  open(name: string, fromPath?: string): Promise<vscode.Uri | undefined>;
  openFromEditorOrPicker(): Promise<vscode.Uri | undefined>;
}

export function docUri(name: string, fromPath?: string): vscode.Uri {
  const fileName = `${name.replace(/[^\w.-]/g, "_")}.md`;
  const query = new URLSearchParams({ name, ...(fromPath ? { from: fromPath } : {}) }).toString();
  return vscode.Uri.from({ scheme: DOC_SCHEME, path: `/${fileName}`, query });
}

export function createDocPreview(client: IndexClient, discovery: Discovery, log: vscode.LogOutputChannel): DocPreview {
  const contents = new Map<string, string>();
  const changed = new vscode.EventEmitter<vscode.Uri>();

  const provider = vscode.workspace.registerTextDocumentContentProvider(DOC_SCHEME, {
    onDidChange: changed.event,
    provideTextDocumentContent: (uri) => contents.get(uri.toString()) ?? "",
  });

  const open = async (name: string, fromPath?: string) => {
    const markdown = await client.documentation(name, fromPath);
    if (markdown === undefined) {
      void vscode.window.showInformationMessage(`rozone: no documentation found for ${name}.`);
      return undefined;
    }
    const uri = docUri(name, fromPath);
    contents.set(uri.toString(), markdown);
    changed.fire(uri);
    await vscode.commands.executeCommand("markdown.showPreview", uri);
    return uri;
  };

  const nameUnderCursor = async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== "r") return undefined;
    const path = pathKey(editor.document.uri);
    discovery.flushPending(path);
    const hover = await client.hover(path, editor.document.offsetAt(editor.selection.active));
    return hover ? { name: hover.name, path } : undefined;
  };

  const pick = async () => {
    const functions = await client.documentedFunctions();
    if (functions.length === 0) {
      void vscode.window.showInformationMessage("rozone: no documented functions in this workspace.");
      return undefined;
    }
    const items = functions
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .map((fn) => ({
        label: fn.name,
        description: fn.title ?? undefined,
        detail: vscode.workspace.asRelativePath(fn.path),
        fn,
      }));
    return vscode.window.showQuickPick(items, { placeHolder: "Open documentation for...", matchOnDescription: true });
  };

  return {
    open,
    async openFromEditorOrPicker() {
      try {
        const here = await nameUnderCursor();
        if (here) return await open(here.name, here.path);
        const chosen = await pick();
        return chosen ? await open(chosen.fn.name, chosen.fn.path) : undefined;
      } catch (error) {
        log.error(`open documentation failed: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      }
    },
    dispose() {
      provider.dispose();
      changed.dispose();
      contents.clear();
    },
  };
}
