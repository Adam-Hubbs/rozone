// Newer provider registrations sort ahead of older ones, so re-registering after Ark's
// language server has started keeps rozone's signature help first. Nothing here runs R or starts a session.

export interface DisposableLike {
  dispose(): void;
}

export interface Event<T> {
  (listener: (value: T) => void): DisposableLike;
}

export interface SessionLike {
  onDidChangeRuntimeState?: Event<string>;
}

export interface PositronLike {
  runtime: {
    onDidChangeForegroundSession: Event<string | undefined>;
    onDidRegisterRuntime: Event<unknown>;
    getActiveSessions(): PromiseLike<SessionLike[]>;
  };
}

export interface Reregistrar extends DisposableLike {
  reregister(): void;
}

export function createReregistrar(register: () => DisposableLike): Reregistrar {
  let current: DisposableLike | undefined = register();
  return {
    reregister() {
      if (!current) return;
      const previous = current;
      current = register();
      previous.dispose();
    },
    dispose() {
      current?.dispose();
      current = undefined;
    },
  };
}

export interface OrderingOptions {
  /** Ark finishes registering after the state change that triggers us, so retry a little later too. */
  delaysMs?: readonly number[];
  setTimeout?: (callback: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

/** States after which Ark (re)starts its language server. */
const TRIGGER_STATES = new Set(["ready", "restarting"]);

export function reregisterOnPositronEvents(
  positron: PositronLike,
  reregistrar: Reregistrar,
  options: OrderingOptions = {},
): DisposableLike {
  const delays = options.delaysMs ?? [250, 2000];
  const schedule = options.setTimeout ?? ((callback, ms) => setTimeout(callback, ms));
  const cancel = options.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const handles = new Set<unknown>();
  const subscriptions: DisposableLike[] = [];
  const watched = new Map<SessionLike, DisposableLike>();
  let disposed = false;

  const run = () => {
    for (const delay of delays) {
      const handle = schedule(() => {
        handles.delete(handle);
        if (!disposed) reregistrar.reregister();
      }, delay);
      handles.add(handle);
    }
  };

  const watch = (session: SessionLike) => {
    if (watched.has(session) || !session.onDidChangeRuntimeState) return;
    watched.set(
      session,
      session.onDidChangeRuntimeState((state) => {
        if (TRIGGER_STATES.has(state)) run();
      }),
    );
  };

  // Sessions that are no longer active are released here, so subscriptions don't pile up over a long-lived window.
  const watchActive = () => {
    void Promise.resolve(positron.runtime.getActiveSessions()).then(
      (sessions) => {
        if (disposed) return;
        const active = new Set(sessions);
        for (const [session, subscription] of watched) {
          if (active.has(session)) continue;
          subscription.dispose();
          watched.delete(session);
        }
        sessions.forEach(watch);
      },
      () => {},
    );
  };

  subscriptions.push(
    positron.runtime.onDidChangeForegroundSession(() => {
      watchActive();
      run();
    }),
    positron.runtime.onDidRegisterRuntime(() => watchActive()),
  );
  watchActive();

  return {
    dispose() {
      disposed = true;
      handles.forEach(cancel);
      handles.clear();
      subscriptions.forEach((subscription) => subscription.dispose());
      watched.forEach((subscription) => subscription.dispose());
      watched.clear();
    },
  };
}
