import { tryAcquirePositronApi } from "@posit-dev/positron";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import * as vscode from "vscode";
import type { BaseTierApi } from "../enhanced/api.ts";
import { createDiscovery, type Discovery } from "./discovery.ts";
import { createDocPreview, type DocPreview } from "./docPreview.ts";
import { createIndexClient, type IndexClient } from "./indexClient.ts";
import { createReregistrar, reregisterOnPositronEvents, type PositronLike, type Reregistrar } from "./positronOrdering.ts";
import { registerHover, registerSignatureHelp, type ProviderDeps } from "./providers.ts";
import type { WorkerData } from "./worker.ts";

export interface BaseTier {
  api: BaseTierApi;
  client: IndexClient;
  discovery: Discovery;
  docPreview: DocPreview;
  signatureHelp: Reregistrar;
  injectedTopics(): ReadonlySet<string>;
  dispose(): Promise<void>;
}

export function startBaseTier(context: vscode.ExtensionContext, log: vscode.LogOutputChannel): BaseTier {
  const dist = path.join(context.extensionPath, "dist");
  const workerData: WorkerData = { wasmEntry: path.join(dist, "wasm", "rozone_wasm.js") };

  let resync: (() => void) | undefined;
  const client = createIndexClient({
    createWorker: () => new Worker(path.join(dist, "worker.cjs"), { workerData }),
    log: (level, message) => log[level](message),
    onRestart: () => resync?.(),
  });
  const discovery = createDiscovery(client, log);
  resync = () => void discovery.resync();
  const docPreview = createDocPreview(client, discovery, log);

  let injected: ReadonlySet<string> = new Set();
  const deps: ProviderDeps = { client, discovery, injectedTopics: () => injected, log };

  const hover = registerHover(deps);
  const signatureHelp = createReregistrar(() => registerSignatureHelp(deps));

  const positron = tryAcquirePositronApi();
  const ordering = positron
    ? reregisterOnPositronEvents(positron as unknown as PositronLike, signatureHelp)
    : undefined;
  if (positron) log.info("running in Positron; signature help re-registers on session events");

  const api: BaseTierApi = {
    loadManifest: (json) => client.loadManifest(json),
    clearManifest: () => client.clearManifest(),
    contentHash: (text) => client.contentHash(text),
    fingerprints: () => client.fingerprints(),
    texts: (paths) => client.texts(paths),
    indexedFiles: () => discovery.indexedFiles(),
    setInjectedTopics: (names) => {
      injected = new Set(names);
    },
    ready: discovery.ready,
    onDidSaveRFile: discovery.onDidSaveRFile,
    log,
  };

  return {
    api,
    client,
    discovery,
    docPreview,
    signatureHelp,
    injectedTopics: () => injected,
    async dispose() {
      ordering?.dispose();
      signatureHelp.dispose();
      hover.dispose();
      docPreview.dispose();
      discovery.dispose();
      await client.dispose();
    },
  };
}
