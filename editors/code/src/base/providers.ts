import * as vscode from "vscode";
import type { Discovery } from "./discovery.ts";
import type { IndexClient } from "./indexClient.ts";
import { shouldShowHover, toHoverModel, toSignatureModel } from "./mapping.ts";
import { pathKey } from "./paths.ts";

export const R_SELECTOR: vscode.DocumentSelector = [
  { language: "r", scheme: "file" },
  { language: "r", scheme: "untitled" },
];

export interface ProviderDeps {
  client: IndexClient;
  discovery: Discovery;
  injectedTopics(): ReadonlySet<string>;
  log: vscode.LogOutputChannel;
}

function plainMarkdown(value: string): vscode.MarkdownString {
  // Untrusted, no HTML and no command links: docs come from files in the workspace.
  const markdown = new vscode.MarkdownString(value);
  markdown.isTrusted = false;
  markdown.supportHtml = false;
  return markdown;
}

function timed<T>(deps: ProviderDeps, what: string, work: () => Promise<T>): Promise<T> {
  const started = performance.now();
  return work().finally(() => deps.log.trace(`${what} took ${(performance.now() - started).toFixed(2)} ms`));
}

export function createHoverProvider(deps: ProviderDeps): vscode.HoverProvider {
  return {
    async provideHover(document, position) {
      const path = pathKey(document.uri);
      if (!deps.discovery.isIndexed(path)) return undefined;
      try {
        return await timed(deps, "hover", async () => {
          deps.discovery.flushPending();
          const hover = await deps.client.hover(path, document.offsetAt(position));
          if (!hover || !shouldShowHover(hover, deps.injectedTopics())) return undefined;
          const model = toHoverModel(hover);
          const range = new vscode.Range(document.positionAt(model.range.start), document.positionAt(model.range.end));
          return new vscode.Hover(plainMarkdown(model.markdown), range);
        });
      } catch (error) {
        deps.log.warn(`hover failed: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      }
    },
  };
}

export function createSignatureHelpProvider(deps: ProviderDeps): vscode.SignatureHelpProvider {
  return {
    async provideSignatureHelp(document, position) {
      const path = pathKey(document.uri);
      if (!deps.discovery.isIndexed(path)) return undefined;
      try {
        return await timed(deps, "signatureHelp", async () => {
          deps.discovery.flushPending();
          const help = await deps.client.signatureHelp(path, document.offsetAt(position));
          if (!help) return undefined;
          const model = toSignatureModel(help);
          const signature = new vscode.SignatureInformation(model.label, plainMarkdown(model.documentation));
          signature.parameters = model.parameters.map(
            (parameter) => new vscode.ParameterInformation(parameter.label, plainMarkdown(parameter.documentation)),
          );
          signature.activeParameter = model.activeParameter;
          const result = new vscode.SignatureHelp();
          result.signatures = [signature];
          result.activeSignature = 0;
          result.activeParameter = model.activeParameter;
          return result;
        });
      } catch (error) {
        deps.log.warn(`signature help failed: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      }
    },
  };
}

export const SIGNATURE_METADATA: vscode.SignatureHelpProviderMetadata = {
  triggerCharacters: ["(", ","],
  retriggerCharacters: [")"],
};

export function registerSignatureHelp(deps: ProviderDeps): vscode.Disposable {
  return vscode.languages.registerSignatureHelpProvider(R_SELECTOR, createSignatureHelpProvider(deps), SIGNATURE_METADATA);
}

export function registerHover(deps: ProviderDeps): vscode.Disposable {
  return vscode.languages.registerHoverProvider(R_SELECTOR, createHoverProvider(deps));
}
