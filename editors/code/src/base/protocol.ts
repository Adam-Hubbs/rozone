import type { CoreHover, CoreSignatureHelp, FileFingerprint, FileText, FunctionSummary, LogLevel } from "./types.ts";

export interface Methods {
  updateFiles: { params: { files: FileText[] }; result: void };
  removeFiles: { params: { paths: string[] }; result: void };
  loadManifest: { params: { json: string }; result: void };
  clearManifest: { params: Record<string, never>; result: void };
  hover: { params: { path: string; offset: number }; result: CoreHover | undefined };
  signatureHelp: { params: { path: string; offset: number }; result: CoreSignatureHelp | undefined };
  documentation: { params: { name: string; fromPath?: string }; result: string | undefined };
  documentedFunctions: { params: Record<string, never>; result: FunctionSummary[] };
  contentHash: { params: { text: string }; result: string };
  fingerprints: { params: Record<string, never>; result: FileFingerprint[] };
  /** The indexed text of each path, `null` for paths the index doesn't hold. */
  texts: { params: { paths: string[] }; result: (string | null)[] };
}

export type MethodName = keyof Methods;

export type RequestMessage = {
  [M in MethodName]: { id: number; method: M; params: Methods[M]["params"] };
}[MethodName];

export interface ErrorPayload {
  message: string;
  panic: boolean;
}

export type ResponseMessage =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: ErrorPayload };

export type WorkerEvent =
  | { event: "ready"; version: string }
  | { event: "log"; level: LogLevel; message: string }
  | { event: "fatal"; message: string };

export type WorkerMessage = ResponseMessage | WorkerEvent;

export function isResponse(message: WorkerMessage): message is ResponseMessage {
  return "id" in message;
}
