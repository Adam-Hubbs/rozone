import type { Disposable, PositronBridge, SessionState } from "./positronBridge.ts";
import type { LibStore } from "./libStore.ts";
import type { Logger } from "./sidecarClient.ts";

export function rStringLiteral(value: string): string {
  const escaped = value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r");
  return `"${escaped}"`;
}

export function injectionSnippet(libDir: string): string {
  return [
    "local({",
    '  if (isNamespaceLoaded("rozone.docs")) unloadNamespace("rozone.docs")',
    `  loadNamespace("rozone.docs", lib.loc = ${rStringLiteral(libDir)})`,
    "  invisible()",
    "})",
  ].join("\n");
}

export interface InjectorDeps {
  bridge: PositronBridge;
  store: LibStore;
  log: Logger;
  /** Ask the controller for a build, e.g. when the foreground session has no library of its own yet. */
  requestBuild(): void;
  setInjectedTopics(names: ReadonlySet<string>): void;
  /** Called whenever "docs are loaded in the foreground session" flips. */
  onActiveChange(active: boolean): void;
}

interface Build {
  sessionId: string;
  libDir: string;
  topics: readonly string[];
}

// The process may live on in these cases (restart, another window, extension host reload), so keep its folders.
const KEEP_ON_EXIT: ReadonlySet<string> = new Set(["restart", "transferred", "extensionHost"]);

const SETTLED_STATES: ReadonlySet<SessionState> = new Set(["ready", "idle"]);
const GONE_STATES: ReadonlySet<SessionState> = new Set([
  "starting",
  "restarting",
  "exiting",
  "exited",
  "offline",
  "uninitialized",
  "initializing",
]);

/** Keeps the latest generated rozone.docs library loaded in the foreground R session. Never starts a session. */
export class PositronInjector {
  #deps: InjectorDeps;
  #build: Build | undefined;
  #injected: { sessionId: string; libDir: string } | undefined;
  #buildRequestedFor: string | undefined;
  #active = false;
  #running = false;
  #rerun = false;
  #subscriptions: Disposable[] = [];
  #endWatchers = new Map<string, Disposable>();
  #disposed = false;

  constructor(deps: InjectorDeps) {
    this.#deps = deps;
    this.#subscriptions.push(
      deps.bridge.onDidChangeForegroundSession(() => {
        this.#buildRequestedFor = undefined;
        this.#markNotInjected();
        void this.#attempt();
      }),
      deps.bridge.onDidChangeSessionState(({ sessionId, state }) => {
        if (GONE_STATES.has(state)) {
          if (this.#injected?.sessionId === sessionId) this.#markNotInjected();
        } else if (SETTLED_STATES.has(state)) {
          void this.#attempt();
        }
      }),
    );
  }

  get active(): boolean {
    return this.#active;
  }

  /** Where the next build should be installed: the foreground R session's own folder. */
  async buildTarget(): Promise<{ sessionId: string; libRoot: string } | undefined> {
    const session = await this.#deps.bridge.foregroundSession();
    if (!session || this.#disposed) return undefined;
    this.#watchEnd(session.id);
    return { sessionId: session.id, libRoot: this.#deps.store.sessionRoot(session.id) };
  }

  /** A fresh build for a session is available; load it as soon as that session is able to take it. */
  inject(sessionId: string, libDir: string, topics: readonly string[]): Promise<void> {
    this.#build = { sessionId, libDir, topics };
    return this.#attempt();
  }

  /** Forget the build (injection turned off or sidecar stopped for good). The loaded namespace is left alone. */
  clear(): void {
    this.#build = undefined;
    this.#markNotInjected();
  }

  dispose(): void {
    this.#disposed = true;
    for (const s of this.#subscriptions) s.dispose();
    this.#subscriptions = [];
    for (const w of this.#endWatchers.values()) w.dispose();
    this.#endWatchers.clear();
  }

  #watchEnd(sessionId: string): void {
    if (this.#endWatchers.has(sessionId)) return;
    this.#endWatchers.set(
      sessionId,
      this.#deps.bridge.onDidEndSession(sessionId, (reason) => {
        if (KEEP_ON_EXIT.has(reason)) return;
        this.#endWatchers.get(sessionId)?.dispose();
        this.#endWatchers.delete(sessionId);
        if (this.#build?.sessionId === sessionId) this.#build = undefined;
        if (this.#injected?.sessionId === sessionId) this.#markNotInjected();
        void this.#deps.store.remove(sessionId);
      }),
    );
  }

  #markNotInjected(): void {
    this.#injected = undefined;
    this.#deps.setInjectedTopics(new Set());
    this.#setActive(false);
  }

  #setActive(active: boolean): void {
    if (this.#active === active) return;
    this.#active = active;
    this.#deps.onActiveChange(active);
  }

  async #attempt(): Promise<void> {
    if (this.#running) {
      this.#rerun = true;
      return;
    }
    this.#running = true;
    try {
      do {
        this.#rerun = false;
        await this.#attemptOnce();
      } while (this.#rerun && !this.#disposed);
    } finally {
      this.#running = false;
    }
  }

  async #attemptOnce(): Promise<void> {
    const build = this.#build;
    if (!build || this.#disposed) return;
    const { bridge, log } = this.#deps;
    const session = await bridge.foregroundSession();
    if (!session) return;
    if (build.sessionId !== session.id) {
      // Once per foreground session: settled-state events fire after every console command.
      if (this.#buildRequestedFor !== session.id) {
        this.#buildRequestedFor = session.id;
        this.#deps.requestBuild();
      }
      return;
    }
    if (this.#injected?.sessionId === session.id && this.#injected.libDir === build.libDir) return;
    const outcome = await bridge.evaluate(session.id, injectionSnippet(build.libDir));
    if (this.#disposed || this.#build !== build) return;
    if (outcome.status === "busy") {
      log.info("R session busy; will inject docs when it is idle");
      return;
    }
    if (outcome.status === "error") {
      log.warn(`injecting rozone.docs failed: ${outcome.message}`);
      return;
    }
    this.#injected = { sessionId: session.id, libDir: build.libDir };
    this.#deps.setInjectedTopics(new Set(build.topics));
    this.#setActive(true);
    log.info(`injected rozone.docs (${build.topics.length} topics) into session ${session.id}`);
    try {
      await this.#deps.store.prune(session.id, build.libDir);
    } catch (error) {
      log.warn(`could not prune old libraries of session ${session.id}: ${String(error)}`);
    }
  }
}
