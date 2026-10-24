import assert from "node:assert/strict";
import * as path from "node:path";
import * as vscode from "vscode";
import type { RozoneExports } from "../../src/extension.ts";

export const EXTENSION_ID = "rozone.rozone";

export const isPositron = () => vscode.env.appName.toLowerCase().includes("positron");

export async function activateRozone(): Promise<RozoneExports> {
  const extension = vscode.extensions.getExtension<RozoneExports>(EXTENSION_ID);
  assert.ok(extension, `${EXTENSION_ID} is not installed in the test host`);
  const exports = await extension.activate();
  assert.ok(exports?.base, "activate() must return the base tier API");
  return exports;
}

export function workspaceRoot(): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, "tests need the fixture workspace folder");
  return folder.uri;
}

export const fixture = (...segments: string[]) => vscode.Uri.joinPath(workspaceRoot(), ...segments);

export async function waitFor<T>(
  what: string,
  check: () => T | undefined | false | Promise<T | undefined | false>,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

export async function waitForIndexed(exports: RozoneExports, fsPath: string): Promise<void> {
  await waitFor(`${fsPath} to be indexed`, () => exports.base.indexedFiles().includes(fsPath));
}

export async function waitForInitialIndex(exports: RozoneExports): Promise<void> {
  await exports._test.tier.discovery.ready;
}

/** Position `offset` characters into the `occurrence`-th match of `needle`. */
export function positionOf(document: vscode.TextDocument, needle: string, offset = 0, occurrence = 0): vscode.Position {
  const text = document.getText();
  let index = -1;
  for (let i = 0; i <= occurrence; i++) {
    index = text.indexOf(needle, index + 1);
    assert.notEqual(index, -1, `"${needle}" (occurrence ${occurrence}) not found in ${document.uri.toString()}`);
  }
  return document.positionAt(index + offset);
}

export function hoverText(hovers: readonly vscode.Hover[]): string {
  return hovers
    .flatMap((hover) => hover.contents)
    .map((content) => (typeof content === "string" ? content : content.value))
    .join("\n");
}

export async function openFixture(...segments: string[]): Promise<vscode.TextDocument> {
  return vscode.workspace.openTextDocument(fixture(...segments));
}

export async function openUntitled(content: string): Promise<vscode.TextDocument> {
  return vscode.workspace.openTextDocument({ language: "r", content });
}

export async function hoversAt(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Hover[]> {
  const hovers = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", document.uri, position);
  return hovers ?? [];
}

export async function signatureAt(
  document: vscode.TextDocument,
  position: vscode.Position,
  trigger?: string,
): Promise<vscode.SignatureHelp | undefined> {
  return vscode.commands.executeCommand<vscode.SignatureHelp | undefined>(
    "vscode.executeSignatureHelpProvider",
    document.uri,
    position,
    trigger,
  );
}

export async function replaceAll(document: vscode.TextDocument, text: string): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), text);
  assert.ok(await vscode.workspace.applyEdit(edit), "workspace edit was rejected");
}

export async function appendText(document: vscode.TextDocument, text: string): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  edit.insert(document.uri, document.positionAt(document.getText().length), text);
  assert.ok(await vscode.workspace.applyEdit(edit), "workspace edit was rejected");
}

/** Revert dirty file documents and close everything so tests do not leak edits into each other. */
export async function resetEditors(): Promise<void> {
  for (const document of vscode.workspace.textDocuments) {
    if (!document.isDirty) continue;
    await vscode.window.showTextDocument(document);
    await vscode.commands.executeCommand(
      document.uri.scheme === "untitled" ? "workbench.action.revertAndCloseActiveEditor" : "workbench.action.files.revert",
    );
  }
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
}

export function percentile(values: number[], p: number): number {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] as number;
}

export const fsPathOf = (...segments: string[]) => path.join(workspaceRoot().fsPath, ...segments);
