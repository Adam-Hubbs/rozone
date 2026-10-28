// The narrow slice of Positron that rozone needs. Everything else in the enhanced
// tier talks to this interface, never to the Positron API, so it can be faked in tests.

export interface Disposable {
  dispose(): void;
}

export interface RSession {
  id: string;
  /** `runtimeMetadata.runtimePath` of the session. */
  runtimePath: string;
}

/** Lifecycle states, mirroring Positron's RuntimeState. */
export type SessionState =
  | "uninitialized"
  | "initializing"
  | "starting"
  | "ready"
  | "idle"
  | "busy"
  | "restarting"
  | "exiting"
  | "exited"
  | "offline"
  | "interrupting";

export type EvalOutcome =
  | { status: "ok"; value: unknown }
  | { status: "busy" }
  | { status: "error"; message: string };

export interface PositronBridge {
  foregroundSession(): Promise<RSession | undefined>;
  /** Runs code in a session without queueing behind other work (RuntimeBusyBehavior.Reject); an error after a timeout. */
  evaluate(sessionId: string, code: string): Promise<EvalOutcome>;
  /** Runs code visibly in the R console, as if the user typed it; resolves when it finishes. */
  executeInConsole(code: string): Promise<void>;
  onDidChangeForegroundSession(listener: (session: RSession | undefined) => void): Disposable;
  /** State changes of the foreground session only. */
  onDidChangeSessionState(listener: (event: { sessionId: string; state: SessionState }) => void): Disposable;
  /** Ids of all live R sessions, in any window state Positron knows about. */
  activeSessionIds(): Promise<string[]>;
  /** Fires once with Positron's `RuntimeExitReason` string when the session's process ends. */
  onDidEndSession(sessionId: string, listener: (reason: string) => void): Disposable;
}
