import { isResponse, type Methods, type MethodName, type RequestMessage, type WorkerMessage } from "./protocol.ts";
import type { CoreHover, CoreSignatureHelp, FileFingerprint, FileText, FunctionSummary, LogFn } from "./types.ts";

export interface WorkerLike {
  postMessage(message: unknown): void;
  on(event: string, listener: (...args: any[]) => void): unknown;
  terminate(): Promise<unknown>;
}

export interface IndexClientOptions {
  createWorker(): WorkerLike;
  log: LogFn;
  /** A crashed worker came back empty; resend every file. The manifest is replayed by the client. */
  onRestart?(): void;
  requestTimeoutMs?: number;
  maxRestarts?: number;
  restartWindowMs?: number;
}

export type ClientState = "running" | "failed" | "disposed";

export class IndexError extends Error {
  panic: boolean;
  constructor(message: string, panic = false) {
    super(message);
    this.name = "IndexError";
    this.panic = panic;
  }
}

export interface IndexClient {
  state(): ClientState;
  updateFiles(files: FileText[]): Promise<void>;
  removeFiles(paths: string[]): Promise<void>;
  loadManifest(json: string): Promise<void>;
  clearManifest(): Promise<void>;
  hover(path: string, offset: number): Promise<CoreHover | undefined>;
  signatureHelp(path: string, offset: number): Promise<CoreSignatureHelp | undefined>;
  documentation(name: string, fromPath?: string): Promise<string | undefined>;
  documentedFunctions(): Promise<FunctionSummary[]>;
  contentHash(text: string): Promise<string>;
  fingerprints(): Promise<FileFingerprint[]>;
  texts(paths: string[]): Promise<(string | null)[]>;
  dispose(): Promise<void>;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export function createIndexClient(options: IndexClientOptions): IndexClient {
  const { log } = options;
  const requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  const maxRestarts = options.maxRestarts ?? 5;
  const restartWindowMs = options.restartWindowMs ?? 60_000;

  const pending = new Map<number, Pending>();
  let manifest: string | undefined;
  let state: ClientState = "running";
  let nextId = 1;
  let restarts: number[] = [];
  let worker: WorkerLike;

  const rejectAll = (error: Error) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };

  const post = (message: RequestMessage) => worker.postMessage(message);

  // File texts are not kept here (the worker and the editor already hold them), so the owner resends them.
  const replay = () => {
    if (manifest !== undefined) post({ id: nextId++, method: "loadManifest", params: { json: manifest } });
    options.onRestart?.();
  };

  const fail = (reason: string) => {
    state = "failed";
    log("error", `rozone index unavailable: ${reason}`);
    rejectAll(new IndexError(`rozone index unavailable: ${reason}`));
  };

  const crash = (crashed: WorkerLike, reason: string) => {
    if (crashed !== worker || state !== "running") return;
    log("error", `index worker stopped (${reason})`);
    rejectAll(new IndexError(`index worker stopped: ${reason}`));
    void crashed.terminate().catch(() => {});
    const now = Date.now();
    restarts = restarts.filter((at) => now - at < restartWindowMs);
    if (restarts.length >= maxRestarts) {
      fail(`worker crashed ${restarts.length + 1} times within ${restartWindowMs} ms`);
      return;
    }
    restarts.push(now);
    start();
    log("info", "index worker restarted; resending files");
    replay();
  };

  const onMessage = (message: WorkerMessage) => {
    if (!isResponse(message)) {
      if (message.event === "log") log(message.level, `[worker] ${message.message}`);
      else if (message.event === "fatal") fail(message.message);
      else log("debug", `index worker ready (wasm ${message.version})`);
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.ok) entry.resolve(message.result);
    else entry.reject(new IndexError(message.error.message, message.error.panic));
  };

  function start() {
    const created = options.createWorker();
    worker = created;
    created.on("message", (message: WorkerMessage) => {
      if (created === worker) onMessage(message);
    });
    created.on("error", (error: Error) => crash(created, error.message));
    created.on("exit", (code: number) => crash(created, `exit code ${code}`));
  }

  function request<M extends MethodName>(method: M, params: Methods[M]["params"]): Promise<Methods[M]["result"]> {
    if (state !== "running") return Promise.reject(new IndexError(`rozone index is ${state}`));
    const id = nextId++;
    const current = worker;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!pending.delete(id)) return;
        reject(new IndexError(`${method} timed out after ${requestTimeoutMs} ms`));
        crash(current, `${method} timed out`);
      }, requestTimeoutMs);
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      post({ id, method, params } as RequestMessage);
    });
  }

  start();

  return {
    state: () => state,
    updateFiles: (files) => request("updateFiles", { files }),
    removeFiles: (paths) => request("removeFiles", { paths }),
    async loadManifest(json) {
      await request("loadManifest", { json });
      manifest = json;
    },
    async clearManifest() {
      manifest = undefined;
      await request("clearManifest", {});
    },
    hover: (path, offset) => request("hover", { path, offset }),
    signatureHelp: (path, offset) => request("signatureHelp", { path, offset }),
    documentation: (name, fromPath) => request("documentation", { name, fromPath }),
    documentedFunctions: () => request("documentedFunctions", {}),
    contentHash: (text) => request("contentHash", { text }),
    fingerprints: () => request("fingerprints", {}),
    texts: (paths) => request("texts", { paths }),
    async dispose() {
      if (state === "disposed") return;
      state = "disposed";
      rejectAll(new IndexError("rozone index disposed"));
      await worker.terminate().catch(() => {});
    },
  };
}
