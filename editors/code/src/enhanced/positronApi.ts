// Adapter from the real Positron extension API to PositronBridge.
import { tryAcquirePositronApi } from "@posit-dev/positron";
import type { PositronApi } from "@posit-dev/positron";
import type { Disposable, EvalOutcome, PositronBridge, RSession, SessionState } from "./positronBridge.ts";

export { tryAcquirePositronApi };

type Session = NonNullable<Awaited<ReturnType<PositronApi["runtime"]["getForegroundSession"]>>>;

const NEVER_CANCELLED = {
  isCancellationRequested: false,
  onCancellationRequested: (): Disposable => ({ dispose() {} }),
};

function toRSession(session: Session | undefined): RSession | undefined {
  if (!session || session.runtimeMetadata.languageId !== "r") return undefined;
  return { id: session.metadata.sessionId, runtimePath: session.runtimeMetadata.runtimePath };
}

const isIdle = (state: string | undefined) => state === undefined || state === "idle" || state === "ready";

export function createPositronBridge(api: PositronApi): PositronBridge {
  const { runtime } = api;

  return {
    async foregroundSession() {
      return toRSession(await runtime.getForegroundSession());
    },

    async evaluate(sessionId, code): Promise<EvalOutcome> {
      const session = await runtime.getSession(sessionId);
      if (!isIdle(session?.getRuntimeState?.())) return { status: "busy" };
      try {
        // Reject, never Queue: a queued evaluation could run long after the build it belongs to.
        const { result } = await runtime.evaluateCode(
          "r",
          code,
          NEVER_CANCELLED as never,
          sessionId,
          api.RuntimeBusyBehavior.Reject,
        );
        return { status: "ok", value: result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const stillIdle = isIdle((await runtime.getSession(sessionId))?.getRuntimeState?.());
        return /busy/i.test(message) || !stillIdle ? { status: "busy" } : { status: "error", message };
      }
    },

    onDidChangeForegroundSession(listener) {
      return runtime.onDidChangeForegroundSession(async () => listener(toRSession(await runtime.getForegroundSession())));
    },

    onDidChangeSessionState(listener) {
      let stateSub: Disposable | undefined;
      const watch = async () => {
        stateSub?.dispose();
        stateSub = undefined;
        const session = await runtime.getForegroundSession();
        if (!session || session.runtimeMetadata.languageId !== "r") return;
        stateSub = session.onDidChangeRuntimeState?.((state) =>
          listener({ sessionId: session.metadata.sessionId, state: state as SessionState }),
        );
      };
      void watch();
      const foregroundSub = runtime.onDidChangeForegroundSession(() => void watch());
      return {
        dispose() {
          stateSub?.dispose();
          foregroundSub.dispose();
        },
      };
    },
  };
}
