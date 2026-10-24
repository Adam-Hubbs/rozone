// Seam between the base tier (always on) and the enhanced tier (trusted only).
// Owned jointly: change only with a matching edit on both sides.
import type * as vscode from "vscode";

export interface BaseTierApi {
  /** Push a sidecar manifest (docs/contracts.md §3) into the WASM index. */
  loadManifest(json: string): Promise<void>;
  clearManifest(): Promise<void>;
  /** FNV-1a hash from the WASM module (docs/contracts.md §0). */
  contentHash(text: string): Promise<string>;
  /** fsPaths of every R file currently indexed (workspace files, not untitled). */
  indexedFiles(): readonly string[];
  /** Topic names loaded into the Positron session; hover skips call sites for these. */
  setInjectedTopics(names: ReadonlySet<string>): void;
  /** Fires after an indexed R file is saved to disk. */
  readonly onDidSaveRFile: vscode.Event<vscode.Uri>;
  readonly log: vscode.LogOutputChannel;
}

export type TierState =
  | { tier: "base"; reason: "untrusted" | "disabled" | "no-r" | "no-roxygen2" | "crashed" | "virtual" }
  | { tier: "enhanced" }
  | { tier: "enhanced+help" };

/**
 * Implemented in src/enhanced/index.ts. Called once from activate() in every
 * workspace; it must not spawn any process or run any R unless
 * `vscode.workspace.isTrusted` is true, and it owns the status bar item.
 */
export type ActivateEnhanced = (
  context: vscode.ExtensionContext,
  base: BaseTierApi,
) => vscode.Disposable;
