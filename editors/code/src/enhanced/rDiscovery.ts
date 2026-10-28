import * as nodePath from "node:path";
import type { Disposable, PositronBridge, RSession } from "./positronBridge.ts";

export type Platform = NodeJS.Platform;

function pathFor(platform: Platform): nodePath.PlatformPath {
  return platform === "win32" ? nodePath.win32 : nodePath.posix;
}

function rscriptName(platform: Platform): string {
  return platform === "win32" ? "Rscript.exe" : "Rscript";
}

/** Maps `.../bin/R`, `.../bin/x64/R.exe` or an `Rscript` path to the matching Rscript binary. */
export function rscriptNextTo(
  executable: string,
  platform: Platform,
  isFile: (path: string) => boolean,
): string | undefined {
  const p = pathFor(platform);
  const base = p.basename(executable).replace(/\.exe$/i, "").toLowerCase();
  if (base === "rscript") return isFile(executable) ? executable : undefined;
  const sibling = p.join(p.dirname(executable), rscriptName(platform));
  return isFile(sibling) ? sibling : undefined;
}

export function findOnPath(
  pathEnv: string | undefined,
  platform: Platform,
  isFile: (path: string) => boolean,
): string | undefined {
  const p = pathFor(platform);
  const delimiter = platform === "win32" ? ";" : ":";
  for (const dir of (pathEnv ?? "").split(delimiter)) {
    if (dir === "") continue;
    const candidate = p.join(dir, rscriptName(platform));
    if (isFile(candidate)) return candidate;
  }
  return undefined;
}

export interface DiscoveryInput {
  platform: Platform;
  isFile: (path: string) => boolean;
  /** `runtimeMetadata.runtimePath` of Positron's foreground R session. */
  positronRuntimePath?: string | undefined;
  /** Value of `rozone.r.path`. */
  settingPath: string;
  pathEnv: string | undefined;
}

/** Precedence: Positron session's R, then `rozone.r.path`, then Rscript on PATH. */
export function discoverRscript(input: DiscoveryInput): string | undefined {
  const { platform, isFile } = input;
  if (input.positronRuntimePath) {
    const found = rscriptNextTo(input.positronRuntimePath, platform, isFile);
    if (found) return found;
  }
  const setting = input.settingPath.trim();
  if (setting !== "") {
    const found = rscriptNextTo(setting, platform, isFile);
    if (found) return found;
  }
  return findOnPath(input.pathEnv, platform, isFile);
}

/**
 * Positron does not document the shape of an evaluated value, so accept the plausible ones:
 * an array of strings, a `[1] "a" "b"` print, or newline separated paths.
 */
export function parseLibPaths(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string" && v !== "");
  if (typeof value === "object" && value !== null) {
    const text = (value as Record<string, unknown>)["text/plain"];
    return text === undefined ? [] : parseLibPaths(text);
  }
  if (typeof value !== "string") return [];
  const quoted = [...value.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => (m[1] ?? "").replace(/\\(.)/g, "$1"));
  if (quoted.length > 0) return quoted.filter((v) => v !== "");
  return value.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "");
}

export interface LaunchSpec {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export interface LaunchInput {
  rscript: string;
  sidecarScript: string;
  platform: Platform;
  baseEnv: NodeJS.ProcessEnv;
  /** Positron: skip the project .Rprofile and use the live session's libraries instead. */
  positron: boolean;
  libPaths: readonly string[];
}

export function buildLaunch(input: LaunchInput): LaunchSpec {
  const args = [...(input.positron ? ["--no-init-file"] : []), input.sidecarScript];
  const env = { ...input.baseEnv };
  if (input.libPaths.length > 0) {
    env["R_LIBS"] = input.libPaths.join(input.platform === "win32" ? ";" : ":");
  }
  return { command: input.rscript, args, env };
}

/** `withSession`: the launch used a Positron R session's R and libraries. */
export type LaunchResult = ({ ok: true; withSession: boolean } & LaunchSpec) | { ok: false; reason: "no-r" };

export const SESSION_WAIT_MS = 15_000;

/** The foreground R session, waiting up to `timeoutMs` for one to appear (Positron restores sessions after activation). */
export function waitForForegroundSession(bridge: PositronBridge, timeoutMs: number): Promise<RSession | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let subscription: Disposable | undefined;
    const finish = (session: RSession | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      subscription?.dispose();
      resolve(session);
    };
    subscription = bridge.onDidChangeForegroundSession((session) => {
      if (session) finish(session);
    });
    timer = setTimeout(() => finish(undefined), timeoutMs);
    bridge.foregroundSession().then(
      (session) => {
        if (session) finish(session);
      },
      () => {},
    );
  });
}

export interface LaunchResolverDeps {
  platform: Platform;
  isFile: (path: string) => boolean;
  pathEnv: string | undefined;
  baseEnv: NodeJS.ProcessEnv;
  settingPath: () => string;
  sidecarScript: string;
  /** Present only when running inside Positron. */
  positron?: PositronBridge | undefined;
  sessionWaitMs?: number;
  log: { info(message: string): void; warn(message: string): void };
}

/** Only call after the workspace is known to be trusted: it evaluates code in the user's R session. */
export class LaunchResolver {
  #deps: LaunchResolverDeps;
  #libPaths: string[] | undefined;

  constructor(deps: LaunchResolverDeps) {
    this.#deps = deps;
  }

  reset(): void {
    this.#libPaths = undefined;
  }

  async resolve(): Promise<LaunchResult> {
    const d = this.#deps;
    const session = d.positron ? await waitForForegroundSession(d.positron, d.sessionWaitMs ?? SESSION_WAIT_MS) : undefined;
    if (d.positron && !session) d.log.info("no R session in the foreground; starting the sidecar without its libraries");
    const rscript = discoverRscript({
      platform: d.platform,
      isFile: d.isFile,
      positronRuntimePath: session?.runtimePath,
      settingPath: d.settingPath(),
      pathEnv: d.pathEnv,
    });
    if (!rscript) return { ok: false, reason: "no-r" };
    const libPaths = d.positron && session ? await this.#readLibPaths(d.positron, session.id) : [];
    return {
      ok: true,
      withSession: session !== undefined,
      ...buildLaunch({
        rscript,
        sidecarScript: d.sidecarScript,
        platform: d.platform,
        baseEnv: d.baseEnv,
        positron: d.positron !== undefined,
        libPaths,
      }),
    };
  }

  async #readLibPaths(bridge: PositronBridge, sessionId: string): Promise<string[]> {
    if (this.#libPaths) return this.#libPaths;
    const outcome = await bridge.evaluate(sessionId, ".libPaths()");
    if (outcome.status !== "ok") {
      this.#deps.log.warn(`could not read .libPaths() from the Positron session (${outcome.status})`);
      return [];
    }
    this.#libPaths = parseLibPaths(outcome.value);
    return this.#libPaths;
  }
}
