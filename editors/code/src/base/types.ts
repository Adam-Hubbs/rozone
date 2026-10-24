// Plain-object shapes returned by the WASM module (docs/contracts.md §1-§2).
export type HoverKind = "call" | "definition" | "identifier";
export type DocSource = "static" | "manifest";

export interface OffsetRange {
  start: number;
  end: number;
}

export interface CoreHover {
  name: string;
  kind: HoverKind;
  markdown: string;
  range: OffsetRange;
  source: DocSource;
}

export interface CoreParameter {
  label: [number, number];
  documentation: string;
}

export interface CoreSignatureHelp {
  name: string;
  label: string;
  documentation: string;
  parameters: CoreParameter[];
  activeParameter: number | null;
  source: DocSource;
}

export interface FunctionSummary {
  name: string;
  path: string;
  range: OffsetRange;
  title: string | null;
}

export interface FileText {
  path: string;
  text: string;
}

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";
export type LogFn = (level: LogLevel, message: string) => void;
