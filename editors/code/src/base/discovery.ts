import * as vscode from "vscode";
import { createCoalescer } from "./coalescer.ts";
import { createExcludeMatcher, toFindFilesExclude } from "./globs.ts";
import type { IndexClient } from "./indexClient.ts";
import { createIndexedSet, type Origin } from "./indexedSet.ts";
import { exceedsSizeLimit, MAX_FILE_BYTES, pathKey, relativeTo } from "./paths.ts";
import type { FileText } from "./types.ts";

const R_GLOB = "**/*.{R,r}";
const READ_CONCURRENCY = 32;
const SEND_CHUNK = 64;

export interface Discovery extends vscode.Disposable {
  /** Resolves once the first workspace scan has been sent to the index. */
  readonly ready: Promise<void>;
  readonly onDidSaveRFile: vscode.Event<vscode.Uri>;
  indexedFiles(): readonly string[];
  isIndexed(path: string): boolean;
  /** Push any coalesced edit for this document now so the next query sees it. */
  flushPending(path: string): void;
  rescan(): Promise<void>;
}

export function createDiscovery(client: IndexClient, log: vscode.LogOutputChannel): Discovery {
  const indexed = createIndexedSet();
  const saved = new vscode.EventEmitter<vscode.Uri>();
  const oversized = new Set<string>();
  const disposables: vscode.Disposable[] = [saved];
  let isExcluded = createExcludeMatcher([]);
  let excludePatterns: string[] = [];
  let scanQueue: Promise<void> = Promise.resolve();

  const loadConfig = () => {
    excludePatterns = vscode.workspace.getConfiguration("rozone").get<string[]>("files.exclude", []);
    isExcluded = createExcludeMatcher(excludePatterns);
  };

  const logFailure = (what: string) => (error: unknown) =>
    log.warn(`${what}: ${error instanceof Error ? error.message : String(error)}`);

  const isRDocument = (doc: vscode.TextDocument) =>
    doc.languageId === "r" && (doc.uri.scheme === "file" || doc.uri.scheme === "untitled" || !!vscode.workspace.getWorkspaceFolder(doc.uri));

  const originOf = (uri: vscode.Uri): Origin => {
    if (uri.scheme === "untitled") return "untitled";
    return vscode.workspace.getWorkspaceFolder(uri) ? "workspace" : "external";
  };

  const excluded = (uri: vscode.Uri): boolean => {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) return false;
    const relative = relativeTo(folder.uri.path, uri.path);
    return relative !== undefined && isExcluded(relative);
  };

  const openDocument = (uri: vscode.Uri) =>
    vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === uri.toString() && isRDocument(doc));

  const drop = (path: string) => {
    coalescer.delete(path);
    if (indexed.remove(path)) client.removeFiles([path]).catch(logFailure(`removing ${path}`));
  };

  const accept = (path: string, text: string): boolean => {
    if (!exceedsSizeLimit(text)) {
      oversized.delete(path);
      return true;
    }
    if (!oversized.has(path)) {
      oversized.add(path);
      log.info(`skipping ${path}: larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`);
    }
    drop(path);
    return false;
  };

  const send = (files: FileText[]) => {
    const ready = files.filter((file) => indexed.has(file.path) && accept(file.path, file.text));
    if (ready.length > 0) client.updateFiles(ready).catch(logFailure("indexing"));
  };

  const coalescer = createCoalescer<string, vscode.TextDocument>((entries) =>
    send(entries.map(([path, doc]) => ({ path, text: doc.getText() }))),
  );

  const pushLive = (doc: vscode.TextDocument) => {
    const path = pathKey(doc.uri);
    if (!isRDocument(doc) || excluded(doc.uri)) return drop(path);
    indexed.add(path, originOf(doc.uri));
    coalescer.set(path, doc);
  };

  const readDisk = async (uri: vscode.Uri): Promise<string | undefined> => {
    const bytes = await vscode.workspace.fs.readFile(uri);
    if (bytes.byteLength > MAX_FILE_BYTES) {
      const path = pathKey(uri);
      if (!oversized.has(path)) {
        oversized.add(path);
        log.info(`skipping ${path}: larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`);
      }
      return undefined;
    }
    return new TextDecoder("utf-8").decode(bytes);
  };

  /** Live text wins over disk, including when the document opened while the read was in flight. */
  const textFor = async (uri: vscode.Uri): Promise<string | undefined> => {
    const open = openDocument(uri);
    if (open) return open.getText();
    const disk = await readDisk(uri);
    return openDocument(uri)?.getText() ?? disk;
  };

  const indexFromDisk = async (uri: vscode.Uri): Promise<void> => {
    const path = pathKey(uri);
    try {
      const text = await textFor(uri);
      if (text === undefined) return drop(path);
      indexed.add(path, originOf(uri));
      send([{ path, text }]);
    } catch (error) {
      logFailure(`reading ${path}`)(error);
      drop(path);
    }
  };

  const readBatch = async (uris: vscode.Uri[]) => {
    const files: FileText[] = [];
    let next = 0;
    const worker = async () => {
      while (next < uris.length) {
        const uri = uris[next++] as vscode.Uri;
        const path = pathKey(uri);
        try {
          const text = await textFor(uri);
          if (text === undefined) continue;
          indexed.add(path, originOf(uri));
          files.push({ path, text });
        } catch (error) {
          logFailure(`reading ${path}`)(error);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, uris.length) }, worker));
    for (let i = 0; i < files.length; i += SEND_CHUNK) {
      send(files.slice(i, i + SEND_CHUNK));
    }
  };

  const scan = async () => {
    const started = performance.now();
    const found = new Map<string, vscode.Uri>();
    const exclude = toFindFilesExclude(excludePatterns);
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, R_GLOB), exclude);
      for (const uri of uris) if (!excluded(uri)) found.set(pathKey(uri), uri);
    }
    for (const path of indexed.paths()) {
      if (indexed.originOf(path) === "workspace" && !found.has(path)) drop(path);
    }
    await readBatch([...found.values()]);
    log.info(`indexed ${found.size} R files in ${Math.round(performance.now() - started)} ms`);
  };

  const rescan = () => {
    scanQueue = scanQueue.then(scan).catch(logFailure("scanning workspace"));
    return scanQueue;
  };

  loadConfig();
  vscode.workspace.textDocuments.forEach(pushLive);
  const ready = rescan();

  const watcher = vscode.workspace.createFileSystemWatcher(R_GLOB);
  disposables.push(
    watcher,
    watcher.onDidCreate((uri) => {
      if (!excluded(uri)) void indexFromDisk(uri);
    }),
    watcher.onDidChange((uri) => {
      if (!excluded(uri) && !openDocument(uri)) void indexFromDisk(uri);
    }),
    watcher.onDidDelete((uri) => {
      if (!openDocument(uri)) drop(pathKey(uri));
    }),
    vscode.workspace.onDidOpenTextDocument(pushLive),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.contentChanges.length > 0) pushLive(event.document);
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      const path = pathKey(doc.uri);
      if (!indexed.has(path)) return;
      coalescer.delete(path);
      if (indexed.originOf(path) === "workspace") void indexFromDisk(doc.uri);
      else drop(path);
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const path = pathKey(doc.uri);
      if (!indexed.has(path) || doc.uri.scheme === "untitled") return;
      coalescer.flushKey(path);
      saved.fire(doc.uri);
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void rescan()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("rozone.files.exclude")) return;
      loadConfig();
      void rescan();
    }),
  );

  return {
    ready,
    onDidSaveRFile: saved.event,
    indexedFiles: () => indexed.files(),
    isIndexed: (path) => indexed.has(path),
    flushPending: (path) => coalescer.flushKey(path),
    rescan,
    dispose() {
      coalescer.dispose();
      vscode.Disposable.from(...disposables).dispose();
    },
  };
}
