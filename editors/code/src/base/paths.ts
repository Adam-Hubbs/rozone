export interface UriLike {
  scheme: string;
  fsPath: string;
  toString(): string;
}

/** `fsPath` for files; untitled and virtual documents have no usable fsPath, so use the URI string. */
export function pathKey(uri: UriLike): string {
  return uri.scheme === "file" ? uri.fsPath : uri.toString();
}

/** Both arguments are URI paths (forward slashes). Returns undefined when `path` is outside `folder`. */
export function relativeTo(folder: string, path: string): string | undefined {
  const base = folder.endsWith("/") ? folder : `${folder}/`;
  return path.startsWith(base) ? path.slice(base.length) : undefined;
}

export const MAX_FILE_BYTES = 5 * 1024 * 1024;

export function exceedsSizeLimit(text: string, limit = MAX_FILE_BYTES): boolean {
  // A UTF-16 string of n units is at most 3n UTF-8 bytes, so only measure when it could matter.
  if (text.length * 3 <= limit) return false;
  return Buffer.byteLength(text, "utf8") > limit;
}

export function isRFile(path: string): boolean {
  return /\.[Rr]$/.test(path);
}
