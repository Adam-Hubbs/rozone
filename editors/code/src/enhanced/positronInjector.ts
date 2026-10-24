import type { Disposable, PositronBridge, SessionState } from "./positronBridge.ts";
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
  log: Logger;
  setInjectedTopics(names: ReadonlySet<string>): void;
  /** Called whenever "docs are loaded in the foreground session" flips. */
  onActiveChange(active: boolean): void;
}

interface Build {
  libDir: string;
  topics: readonly string[];
}

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
  #active = false;
  #running = false;
  #rerun = false;
  #subscriptions: Disposable[] = [];
  #disposed = false;

  constructor(deps: InjectorDeps) {
    this.#deps = deps;
    this.#subscriptions.push(
      deps.bridge.onDidChangeForegroundSession(() => {
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

  /** A fresh build is available; load it as soon as the session is able to take it. */
  inject(libDir: string, topics: readonly string[]): Promise<void> {
    this.#build = { libDir, topics };
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
  }
}
