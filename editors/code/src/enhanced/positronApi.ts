// Adapter from the real Positron extension API to PositronBridge.
import { tryAcquirePositronApi } from "@posit-dev/positron";
import type { PositronApi } from "@posit-dev/positron";
import * as vscode from "vscode";
import type { Disposable, EvalOutcome, PositronBridge, RSession, SessionState } from "./positronBridge.ts";

export { tryAcquirePositronApi };

type Session = NonNullable<Awaited<ReturnType<PositronApi["runtime"]["getForegroundSession"]>>>;

export const EVALUATE_TIMEOUT_MS = 10_000;

function toRSession(session: Session | undefined): RSession | undefined {
  if (!session || session.runtimeMetadata.languageId !== "r") return undefined;
  return { id: session.metadata.sessionId, runtimePath: session.runtimeMetadata.runtimePath };
}

const isIdle = (state: string | undefined) => state === undefined || state === "idle" || state === "ready";

export function createPositronBridge(api: PositronApi, evaluateTimeoutMs = EVALUATE_TIMEOUT_MS): PositronBridge {
  const { runtime } = api;

  const foreground = async () => toRSession(await runtime.getForegroundSession());

  return {
    foregroundSession: foreground,

    async evaluate(sessionId, code): Promise<EvalOutcome> {
      const session = await runtime.getSession(sessionId);
      if (!isIdle(session?.getRuntimeState?.())) return { status: "busy" };
      const cancellation = new vscode.CancellationTokenSource();
      let timer: ReturnType<typeof setTimeout> | undefined;
      // Cancellation is only a request, so the race is what guarantees callers are never stuck.
      const timedOut = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => {
          cancellation.cancel();
          resolve("timeout");
        }, evaluateTimeoutMs);
      });
      try {
        // Reject, never Queue: a queued evaluation could run long after the build it belongs to.
        const evaluation = runtime.evaluateCode("r", code, cancellation.token, sessionId, api.RuntimeBusyBehavior.Reject);
        const outcome = await Promise.race([Promise.resolve(evaluation), timedOut]);
        if (outcome === "timeout") return { status: "error", message: `evaluation timed out after ${evaluateTimeoutMs} ms` };
        return { status: "ok", value: outcome.result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const stillIdle = isIdle((await runtime.getSession(sessionId))?.getRuntimeState?.());
        return /busy/i.test(message) || !stillIdle ? { status: "busy" } : { status: "error", message };
      } finally {
        clearTimeout(timer);
        cancellation.dispose();
      }
    },

    async executeInConsole(code) {
      await runtime.executeCode("r", code, true);
    },

    async activeSessionIds() {
      const sessions = await runtime.getActiveSessions();
      return sessions.filter((s) => s.runtimeMetadata.languageId === "r").map((s) => s.metadata.sessionId);
    },

    onDidEndSession(sessionId, listener) {
      let sub: Disposable | undefined;
      let disposed = false;
      runtime.getSession(sessionId).then(
        (session) => {
          if (disposed) return;
          const watched = session as
            | { onDidEndSession?: (l: (exit: { reason: string }) => void) => Disposable }
            | undefined;
          sub = watched?.onDidEndSession?.((exit) => listener(exit.reason));
        },
        () => {},
      );
      return {
        dispose() {
          disposed = true;
          sub?.dispose();
        },
      };
    },

    onDidChangeForegroundSession(listener) {
      return runtime.onDidChangeForegroundSession(() => {
        foreground().then(listener, () => {});
      });
    },

    onDidChangeSessionState(listener) {
      let stateSub: Disposable | undefined;
      let generation = 0;
      let disposed = false;
      // Foreground changes can overlap; only the latest one may subscribe, or older subscriptions leak.
      const watch = async () => {
        const mine = ++generation;
        stateSub?.dispose();
        stateSub = undefined;
        const session = await runtime.getForegroundSession();
        if (disposed || mine !== generation) return;
        if (!session || session.runtimeMetadata.languageId !== "r") return;
        stateSub = session.onDidChangeRuntimeState?.((state) =>
          listener({ sessionId: session.metadata.sessionId, state: state as SessionState }),
        );
      };
      const rewatch = () => void watch().catch(() => {});
      rewatch();
      const foregroundSub = runtime.onDidChangeForegroundSession(rewatch);
      return {
        dispose() {
          disposed = true;
          stateSub?.dispose();
          foregroundSub.dispose();
        },
      };
    },
  };
}
