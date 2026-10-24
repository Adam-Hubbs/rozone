export type Origin = "workspace" | "untitled" | "external";

/** Tracks what the worker currently holds so removals and `indexedFiles()` stay cheap and exact. */
export interface IndexedSet {
  add(path: string, origin: Origin): void;
  remove(path: string): boolean;
  has(path: string): boolean;
  originOf(path: string): Origin | undefined;
  /** Workspace and external files on disk; untitled documents are not included. */
  files(): string[];
  paths(): string[];
}

export function createIndexedSet(): IndexedSet {
  const origins = new Map<string, Origin>();
  return {
    add: (path, origin) => void origins.set(path, origin),
    remove: (path) => origins.delete(path),
    has: (path) => origins.has(path),
    originOf: (path) => origins.get(path),
    files: () => [...origins].filter(([, origin]) => origin !== "untitled").map(([path]) => path),
    paths: () => [...origins.keys()],
  };
}
