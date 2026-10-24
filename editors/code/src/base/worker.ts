import { createRequire } from "node:module";
import { parentPort, workerData } from "node:worker_threads";
import { createIndexHost, type IndexHost, type WasmModule } from "./indexHost.ts";
import type { RequestMessage, WorkerMessage } from "./protocol.ts";

export interface WorkerData {
  wasmEntry: string;
}

const port = parentPort;
if (!port) throw new Error("worker.ts must run inside a worker thread");

const post = (message: WorkerMessage) => port.postMessage(message);

let host: IndexHost | undefined;
let loadError: string | undefined;

try {
  const { wasmEntry } = workerData as WorkerData;
  // Loaded through a computed path so the bundler leaves the wasm-pack output alone.
  const wasm = createRequire(wasmEntry)(wasmEntry) as WasmModule;
  host = createIndexHost(wasm, (level, message) => post({ event: "log", level, message }));
  post({ event: "ready", version: wasm.version() });
} catch (error) {
  loadError = error instanceof Error ? error.message : String(error);
  post({ event: "fatal", message: loadError });
}

port.on("message", (request: RequestMessage) => {
  if (!host) {
    post({ id: request.id, ok: false, error: { message: `rozone wasm failed to load: ${loadError}`, panic: false } });
    return;
  }
  post(host.handle(request));
});
