// Just enough glob syntax for rozone.files.exclude: `**`, `*`, `?`, `{a,b}`, `[abc]`.
// Matching is against workspace-relative, forward-slash paths.

function escapeRegex(char: string): string {
  return /[.+^$()|\\]/.test(char) ? `\\${char}` : char;
}

export function globToRegExp(glob: string): RegExp {
  let source = "";
  let braceDepth = 0;
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i] as string;
    if (char === "*") {
      if (glob[i + 1] === "*") {
        const atStart = i === 0 || glob[i - 1] === "/";
        i++;
        if (glob[i + 1] === "/" && atStart) {
          i++;
          source += "(?:.*/)?";
        } else if (i === glob.length - 1 && glob[i - 2] === "/") {
          source = source.replace(/\/$/, "") + "(?:/.*)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else if (char === "{") {
      braceDepth++;
      source += "(?:";
    } else if (char === "}" && braceDepth > 0) {
      braceDepth--;
      source += ")";
    } else if (char === "," && braceDepth > 0) {
      source += "|";
    } else if (char === "[") {
      const close = glob.indexOf("]", i + 1);
      if (close === -1) {
        source += "\\[";
      } else {
        const body = glob.slice(i + 1, close);
        source += body.startsWith("!") ? `[^${body.slice(1)}]` : `[${body}]`;
        i = close;
      }
    } else {
      source += escapeRegex(char);
    }
  }
  return new RegExp(`^${source}$`);
}

export function createExcludeMatcher(patterns: readonly string[]): (relativePath: string) => boolean {
  const regexes = patterns.map((pattern) => globToRegExp(pattern.replace(/^\.?\//, "")));
  return (relativePath) => {
    const normalized = relativePath.replaceAll("\\", "/").replace(/^\//, "");
    return regexes.some((regex) => regex.test(normalized));
  };
}

/** The exclude argument for `workspace.findFiles`; exotic patterns are left to the matcher. */
export function toFindFilesExclude(patterns: readonly string[]): string | undefined {
  const simple = patterns.filter((pattern) => pattern.length > 0 && !/[{},]/.test(pattern));
  if (simple.length === 0) return undefined;
  return simple.length === 1 ? (simple[0] as string) : `{${simple.join(",")}}`;
}
