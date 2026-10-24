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
  /** Runs code in a session without queueing behind other work (RuntimeBusyBehavior.Reject). */
  evaluate(sessionId: string, code: string): Promise<EvalOutcome>;
  onDidChangeForegroundSession(listener: (session: RSession | undefined) => void): Disposable;
  /** State changes of the foreground session only. */
  onDidChangeSessionState(listener: (event: { sessionId: string; state: SessionState }) => void): Disposable;
}
