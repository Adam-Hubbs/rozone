// Adapter from the real Positron extension API to PositronBridge. Positron injects a global
// `acquirePositronApi()` into the extension host (this is what @posit-dev/positron wraps), so
// no runtime dependency is needed. The shapes below are the parts we rely on; they are
// declared locally and everything is defensive because the API is not versioned.
import type { Disposable, EvalOutcome, PositronBridge, RSession, SessionState } from "./positronBridge.ts";

interface PositronEvent<T> {
  (listener: (value: T) => void): Disposable;
}

interface PositronSession {
  metadata: { sessionId: string };
  runtimeMetadata: { runtimePath: string; languageId: string };
  onDidChangeRuntimeState?: PositronEvent<string>;
}

interface PositronRuntime {
  getForegroundSession(): PromiseLike<PositronSession | undefined>;
  onDidChangeForegroundSession: PositronEvent<unknown>;
  evaluateCode?: (
    languageId: string,
    code: string,
    token: unknown,
    sessionId: string,
    busyBehavior: unknown,
  ) => PromiseLike<unknown>;
}

interface PositronApi {
  runtime: PositronRuntime;
  RuntimeBusyBehavior?: { Reject?: unknown };
}

export function tryAcquirePositronApi(): PositronApi | undefined {
  const acquire = (globalThis as { acquirePositronApi?: () => PositronApi }).acquirePositronApi;
  if (typeof acquire !== "function") return undefined;
  try {
    return acquire();
  } catch {
    return undefined;
  }
}

const NEVER_CANCELLED = {
  isCancellationRequested: false,
  onCancellationRequested: (): Disposable => ({ dispose() {} }),
};

function toRSession(session: PositronSession | undefined): RSession | undefined {
  if (!session || session.runtimeMetadata.languageId !== "r") return undefined;
  return { id: session.metadata.sessionId, runtimePath: session.runtimeMetadata.runtimePath };
}

export function createPositronBridge(api: PositronApi): PositronBridge {
  const runtime = api.runtime;
  const foreground = async () => runtime.getForegroundSession();

  return {
    async foregroundSession() {
      return toRSession(await foreground());
    },

    async evaluate(sessionId, code): Promise<EvalOutcome> {
      if (!runtime.evaluateCode) return { status: "error", message: "positron.runtime.evaluateCode is unavailable" };
      try {
        const value = await runtime.evaluateCode("r", code, NEVER_CANCELLED, sessionId, api.RuntimeBusyBehavior?.Reject ?? "reject");
        return { status: "ok", value };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return /busy/i.test(message) ? { status: "busy" } : { status: "error", message };
      }
    },

    onDidChangeForegroundSession(listener) {
      return runtime.onDidChangeForegroundSession(async () => listener(toRSession(await foreground())));
    },

    onDidChangeSessionState(listener) {
      let stateSub: Disposable | undefined;
      const watch = async () => {
        stateSub?.dispose();
        stateSub = undefined;
        const session = await foreground();
        if (!session || session.runtimeMetadata.languageId !== "r") return;
        stateSub = session.onDidChangeRuntimeState?.((state) =>
          listener({ sessionId: session.metadata.sessionId, state: state as SessionState }),
        );
      };
      void watch();
      const fgSub = runtime.onDidChangeForegroundSession(() => void watch());
      return {
        dispose() {
          stateSub?.dispose();
          fgSub.dispose();
        },
      };
    },
  };
}
