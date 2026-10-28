import type { FileFingerprint } from "../base/types.ts";
import type { TierState } from "./api.ts";
import type { LaunchResult, LaunchSpec } from "./rDiscovery.ts";
import { SidecarError } from "./sidecarClient.ts";
import type { ExitInfo, Hello, Logger } from "./sidecarClient.ts";

/** TierState plus the transient "gates pass, sidecar is coming up" phase. */
export type ViewState = TierState | { tier: "starting" };

export interface SidecarLike {
  start(): Promise<Hello>;
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  shutdown(): Promise<void>;
  kill(): void;
  onExit(listener: (info: ExitInfo) => void): () => void;
}

export interface BaseLike {
  loadManifest(json: string): Promise<void>;
  indexedFiles(): readonly string[];
  fingerprints(): Promise<FileFingerprint[]>;
  texts(paths: string[]): Promise<(string | null)[]>;
}

interface BuildFile {
  path: string;
  hash: string;
  text?: string;
}

export interface InjectorLike {
  readonly active: boolean;
  buildTarget(): Promise<{ sessionId: string; libRoot: string } | undefined>;
  inject(sessionId: string, libDir: string, topics: readonly string[]): Promise<void>;
  clear(): void;
}

export interface ControllerDeps {
  base: BaseLike;
  log: Logger;
  env: { isTrusted(): boolean; isVirtual(): boolean; isPositron: boolean };
  config: { enabled(): boolean; idleMinutes(): number; helpInjection(): boolean };
  resolveLaunch(): Promise<LaunchResult>;
  /** Forget cached launch data (library paths) so the next start re-reads it. */
  resetLaunch?(): void;
  createClient(spec: LaunchSpec): SidecarLike;
  injector?: InjectorLike | undefined;
  notifyRoxygenMissing(missing: readonly string[]): void;
  onState(state: ViewState): void;
  now?(): number;
  debounceMs?: number;
  backoffMs?: readonly number[];
  maxCrashes?: number;
  crashWindowMs?: number;
  buildTimeoutMs?: number;
}

type BlockReason = "no-r" | "no-roxygen2" | "crashed";

interface BuildResult {
  manifest: unknown;
  lib_dir: string | null;
  topics: string[];
  cache_hits?: number;
  errors?: { path: string; message: string }[];
}

export class SidecarController {
  #deps: ControllerDeps;
  #client: SidecarLike | undefined;
  #starting: Promise<SidecarLike | undefined> | undefined;
  #epoch = 0;
  #blocked: BlockReason | undefined;
  #enhancedOn = false;
  #crashes: number[] = [];
  #debounceTimer: ReturnType<typeof setTimeout> | undefined;
  #idleTimer: ReturnType<typeof setTimeout> | undefined;
  #restartTimer: ReturnType<typeof setTimeout> | undefined;
  #building = false;
  #dirty = false;
  #disposed = false;
  #roxygenNotified = false;
  #launchedWithSession = false;
  /** Doc hashes and install target of the last successful build; an identical request is skipped. */
  #builtKey: string | undefined;
  #sidecarOf: SidecarLike | undefined;
  #sidecarHas = new Map<string, string>();
  #lastState = "";

  constructor(deps: ControllerDeps) {
    this.#deps = deps;
  }

  get running(): boolean {
    return this.#client !== undefined;
  }

  /** Activation, trust grant, config change. Starts the sidecar and runs the initial build when allowed. */
  async refresh(): Promise<void> {
    const gate = this.#gate();
    if (gate) {
      await this.#stopAll();
      this.updateState();
      return;
    }
    if (this.#blocked === "crashed") {
      this.updateState();
      return;
    }
    if (this.#blocked) this.#blocked = undefined;
    this.updateState();
    await this.#runBuild();
  }

  /** Settings that change how R is launched. Keeps the crash circuit breaker. */
  async reconfigure(): Promise<void> {
    await this.#stopAll();
    this.#deps.resetLaunch?.();
    if (!this.#deps.config.helpInjection()) this.#deps.injector?.clear();
    await this.refresh();
  }

  /** The user command: also clears the crash history. */
  async restart(): Promise<void> {
    this.#crashes = [];
    if (this.#blocked === "crashed") this.#blocked = undefined;
    await this.reconfigure();
  }

  requestBuild(): void {
    if (this.#disposed || this.#gate() || this.#blocked) return;
    clearTimeout(this.#debounceTimer);
    this.#debounceTimer = setTimeout(() => {
      this.#debounceTimer = undefined;
      void this.#runBuild();
    }, this.#deps.debounceMs ?? 300);
  }

  /**
   * A Positron R session came to the foreground. Retry when R or roxygen2 was not found, or when the
   * running sidecar was launched without a session's R and libraries (e.g. renv) because none existed yet.
   */
  async onForegroundSession(): Promise<void> {
    if (this.#disposed || this.#gate() || this.#blocked === "crashed") return;
    const blockedOnSetup = this.#blocked === "no-r" || this.#blocked === "no-roxygen2";
    const withoutSession = this.#client !== undefined && !this.#launchedWithSession;
    if (!blockedOnSetup && !withoutSession) return;
    this.#deps.log.info("R session available; relaunching the sidecar with its R and libraries");
    await this.reconfigure();
  }

  /** Idle timeout setting changed. */
  rearmIdle(): void {
    if (this.#client) this.#armIdle();
  }

  updateState(): void {
    const state = this.#computeState();
    const key = JSON.stringify(state);
    if (key === this.#lastState) return;
    this.#lastState = key;
    this.#deps.onState(state);
  }

  dispose(): void {
    this.#disposed = true;
    this.#epoch++;
    clearTimeout(this.#debounceTimer);
    clearTimeout(this.#idleTimer);
    clearTimeout(this.#restartTimer);
    const client = this.#client;
    this.#client = undefined;
    client?.kill();
  }

  #gate(): "virtual" | "untrusted" | "disabled" | undefined {
    const { env, config } = this.#deps;
    if (env.isVirtual()) return "virtual";
    if (!env.isTrusted()) return "untrusted";
    if (!config.enabled()) return "disabled";
    return undefined;
  }

  #computeState(): ViewState {
    const gate = this.#gate();
    if (gate) return { tier: "base", reason: gate };
    if (this.#blocked) return { tier: "base", reason: this.#blocked };
    if (!this.#enhancedOn) return { tier: "starting" };
    const help = this.#deps.config.helpInjection() && this.#deps.injector?.active === true;
    return help ? { tier: "enhanced+help" } : { tier: "enhanced" };
  }

  #block(reason: BlockReason): void {
    this.#blocked = reason;
    this.#enhancedOn = false;
    this.updateState();
  }

  async #stopAll(): Promise<void> {
    this.#epoch++;
    this.#builtKey = undefined;
    clearTimeout(this.#debounceTimer);
    clearTimeout(this.#restartTimer);
    this.#enhancedOn = false;
    await this.#stopClient();
  }

  async #stopClient(): Promise<void> {
    clearTimeout(this.#idleTimer);
    const client = this.#client;
    this.#client = undefined;
    if (!client) return;
    try {
      await client.shutdown();
    } catch {
      client.kill();
    }
  }

  #armIdle(): void {
    clearTimeout(this.#idleTimer);
    const ms = this.#deps.config.idleMinutes() * 60_000;
    this.#idleTimer = setTimeout(() => {
      this.#deps.log.info("sidecar idle; shutting it down until the next save");
      void this.#stopClient();
    }, ms);
  }

  #ensureClient(): Promise<SidecarLike | undefined> {
    if (this.#client) return Promise.resolve(this.#client);
    this.#starting ??= this.#start().finally(() => {
      this.#starting = undefined;
    });
    return this.#starting;
  }

  async #start(): Promise<SidecarLike | undefined> {
    const epoch = this.#epoch;
    const { log } = this.#deps;
    const launch = await this.#deps.resolveLaunch();
    if (epoch !== this.#epoch) return undefined;
    if (!launch.ok) {
      log.warn("no R installation found; staying in the base tier");
      this.#block("no-r");
      return undefined;
    }
    const client = this.#deps.createClient(launch);
    let hello: Hello;
    try {
      hello = await client.start();
    } catch (error) {
      client.kill();
      if (epoch === this.#epoch) {
        log.error(`sidecar failed to start: ${String(error)}`);
        this.#recordCrash();
      }
      return undefined;
    }
    if (epoch !== this.#epoch) {
      client.kill();
      return undefined;
    }
    if (!hello.ok) {
      log.warn(`sidecar reports missing packages: ${hello.missing.join(", ")}`);
      client.kill();
      this.#block("no-roxygen2");
      if (!this.#roxygenNotified) {
        this.#roxygenNotified = true;
        this.#deps.notifyRoxygenMissing(hello.missing);
      }
      return undefined;
    }
    log.info(`sidecar ready (R ${hello.r_version ?? "?"}, roxygen2 ${hello.packages?.["roxygen2"] ?? "?"})`);
    this.#client = client;
    this.#launchedWithSession = launch.withSession;
    client.onExit((info) => this.#onExit(client, info));
    this.#enhancedOn = true;
    this.updateState();
    return client;
  }

  #onExit(client: SidecarLike, info: ExitInfo): void {
    if (client !== this.#client) return;
    this.#client = undefined;
    clearTimeout(this.#idleTimer);
    if (info.intentional) return;
    this.#deps.log.error(`sidecar exited unexpectedly (code ${String(info.code)}, signal ${String(info.signal)})`);
    this.#recordCrash();
  }

  #recordCrash(): void {
    const now = (this.#deps.now ?? Date.now)();
    const windowMs = this.#deps.crashWindowMs ?? 5 * 60_000;
    this.#crashes = [...this.#crashes.filter((t) => now - t < windowMs), now];
    const count = this.#crashes.length;
    if (count >= (this.#deps.maxCrashes ?? 3)) {
      this.#deps.log.error(`sidecar crashed ${count} times in a short period; staying in the base tier until reload`);
      this.#block("crashed");
      return;
    }
    const backoff = this.#deps.backoffMs ?? [1_000, 2_000];
    const delay = backoff[Math.min(count - 1, backoff.length - 1)] ?? 1_000;
    this.#deps.log.info(`restarting sidecar in ${delay} ms`);
    clearTimeout(this.#restartTimer);
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = undefined;
      if (!this.#disposed) void this.#runBuild();
    }, delay);
  }

  async #runBuild(): Promise<void> {
    if (this.#building) {
      this.#dirty = true;
      return;
    }
    this.#building = true;
    try {
      do {
        this.#dirty = false;
        await this.#buildOnce();
      } while (this.#dirty && !this.#disposed);
    } finally {
      this.#building = false;
    }
  }

  async #buildOnce(): Promise<void> {
    if (this.#disposed || this.#gate() || this.#blocked) return;
    const { log, env, config } = this.#deps;
    // An idle shutdown must not land in the middle of the build that is starting.
    clearTimeout(this.#idleTimer);
    const prints = await this.#fingerprints();
    const wantsInstall = env.isPositron && config.helpInjection() && this.#deps.injector !== undefined;
    const target = wantsInstall ? await this.#deps.injector?.buildTarget() : undefined;
    if (this.#disposed) return;
    const key = [target?.libRoot ?? "", ...prints.map((p) => `${p.path}\0${p.docHash}`)].join("\n");
    if (key === this.#builtKey) {
      log.info("docs unchanged since the last build; R not needed");
      if (this.#client) this.#armIdle();
      return;
    }
    const client = await this.#ensureClient();
    if (!client || this.#disposed) return;
    const files = await this.#filesFor(client, prints);
    try {
      const result = await client.request<BuildResult>(
        "build",
        target ? { files, install: true, lib_root: target.libRoot } : { files, install: false },
        this.#deps.buildTimeoutMs ?? 120_000,
      );
      this.#armIdle();
      // The sidecar keeps a cache entry for exactly the files listed in the last build.
      this.#sidecarHas = new Map(files.map((f) => [f.path, f.hash]));
      this.#builtKey = target && result.lib_dir === null ? undefined : key;
      await this.#applyResult(result, target?.sessionId);
    } catch (error) {
      this.#builtKey = undefined;
      if (error instanceof SidecarError && error.code === "timeout") {
        log.error("sidecar build timed out; restarting it");
        if (this.#client === client) {
          this.#client = undefined;
          client.kill();
          this.#recordCrash();
        }
      } else {
        log.error(`sidecar build failed: ${String(error)}`);
      }
    }
  }

  async #fingerprints(): Promise<FileFingerprint[]> {
    const indexed = new Set(this.#deps.base.indexedFiles());
    return (await this.#deps.base.fingerprints()).filter((p) => indexed.has(p.path));
  }

  /** Text is sent only for files whose doc hash this sidecar process has not built yet. */
  async #filesFor(client: SidecarLike, prints: readonly FileFingerprint[]): Promise<BuildFile[]> {
    if (client !== this.#sidecarOf) {
      this.#sidecarOf = client;
      this.#sidecarHas = new Map();
    }
    const stale = prints.filter((p) => this.#sidecarHas.get(p.path) !== p.docHash);
    const texts = await this.#deps.base.texts(stale.map((p) => p.path));
    const fresh = new Map(stale.map((p, i) => [p.path, texts[i] ?? null]));
    return prints.flatMap((p): BuildFile[] => {
      if (!fresh.has(p.path)) return [{ path: p.path, hash: p.docHash }];
      const text = fresh.get(p.path);
      return typeof text === "string" ? [{ path: p.path, hash: p.docHash, text }] : [];
    });
  }

  async #applyResult(result: BuildResult, sessionId: string | undefined): Promise<void> {
    const { base, log, injector } = this.#deps;
    for (const e of result.errors ?? []) log.warn(`roxygen2 could not process ${e.path}: ${e.message}`);
    try {
      await base.loadManifest(JSON.stringify(result.manifest));
    } catch (error) {
      log.error(`manifest rejected: ${String(error)}`);
    }
    if (result.lib_dir && injector && sessionId) await injector.inject(sessionId, result.lib_dir, result.topics);
    this.updateState();
  }
}
