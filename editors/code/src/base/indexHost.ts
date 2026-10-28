import type { RequestMessage, ResponseMessage } from "./protocol.ts";
import type { CoreHover, CoreSignatureHelp, FileFingerprint, FunctionSummary, LogFn } from "./types.ts";

export interface IndexLike {
  updateFile(path: string, text: string): void;
  removeFile(path: string): void;
  loadManifest(json: string): void;
  clearManifest(): void;
  hover(path: string, offset: number): CoreHover | undefined | null;
  signatureHelp(path: string, offset: number): CoreSignatureHelp | undefined | null;
  documentation(name: string, fromPath?: string): string | undefined | null;
  documentedFunctions(): FunctionSummary[];
  fingerprints(): FileFingerprint[];
  free(): void;
}

export interface WasmModule {
  RozoneIndex: new () => IndexLike;
  contentHash(text: string): string;
  version(): string;
}

export interface IndexHost {
  handle(request: RequestMessage): ResponseMessage;
}

const MAX_REBUILD_ATTEMPTS = 3;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isPanic(error: unknown): boolean {
  if (error instanceof Error && error.constructor.name === "RuntimeError") return true;
  return /unreachable|panicked|recursive use of an object|null pointer passed to rust/i.test(messageOf(error));
}

export function createIndexHost(wasm: WasmModule, log: LogFn): IndexHost {
  const texts = new Map<string, string>();
  let manifestJson: string | undefined;
  let index = new wasm.RozoneIndex();

  const discard = (stale: IndexLike) => {
    try {
      stale.free();
    } catch {
      // A poisoned instance may refuse to free; nothing else holds it.
    }
  };

  // Rebuilding can itself hit the input that caused the panic, so such files are dropped.
  const rebuild = () => {
    discard(index);
    for (let attempt = 1; attempt <= MAX_REBUILD_ATTEMPTS; attempt++) {
      index = new wasm.RozoneIndex();
      const poisoned: string[] = [];
      for (const [path, text] of texts) {
        try {
          index.updateFile(path, text);
        } catch (error) {
          log("error", `dropping ${path} after panic while rebuilding index: ${messageOf(error)}`);
          poisoned.push(path);
        }
      }
      if (poisoned.length === 0) {
        if (manifestJson !== undefined) {
          try {
            index.loadManifest(manifestJson);
          } catch (error) {
            log("warn", `dropping manifest after rebuild: ${messageOf(error)}`);
            manifestJson = undefined;
          }
        }
        return;
      }
      for (const path of poisoned) texts.delete(path);
      discard(index);
    }
    index = new wasm.RozoneIndex();
  };

  const run = (request: RequestMessage): unknown => {
    switch (request.method) {
      case "updateFiles":
        for (const { path, text } of request.params.files) {
          texts.set(path, text);
          try {
            index.updateFile(path, text);
          } catch (error) {
            texts.delete(path);
            throw error;
          }
        }
        return undefined;
      case "removeFiles":
        for (const path of request.params.paths) {
          texts.delete(path);
          index.removeFile(path);
        }
        return undefined;
      case "loadManifest":
        index.loadManifest(request.params.json);
        manifestJson = request.params.json;
        return undefined;
      case "clearManifest":
        index.clearManifest();
        manifestJson = undefined;
        return undefined;
      case "hover":
        return index.hover(request.params.path, request.params.offset) ?? undefined;
      case "signatureHelp":
        return index.signatureHelp(request.params.path, request.params.offset) ?? undefined;
      case "documentation":
        return index.documentation(request.params.name, request.params.fromPath) ?? undefined;
      case "documentedFunctions":
        return index.documentedFunctions();
      case "contentHash":
        return wasm.contentHash(request.params.text);
      case "fingerprints":
        return index.fingerprints();
      case "texts":
        return request.params.paths.map((path) => texts.get(path) ?? null);
    }
  };

  return {
    handle(request) {
      try {
        return { id: request.id, ok: true, result: run(request) };
      } catch (error) {
        // An invalid manifest is a user error; anything else may have left the instance corrupt.
        const panic = request.method !== "loadManifest" || isPanic(error);
        const message = messageOf(error);
        if (panic) {
          log("error", `wasm panic in ${request.method}: ${message}; rebuilding index from ${texts.size} files`);
          try {
            rebuild();
          } catch (rebuildError) {
            log("error", `index rebuild failed: ${messageOf(rebuildError)}`);
          }
        }
        return { id: request.id, ok: false, error: { message, panic } };
      }
    },
  };
}
