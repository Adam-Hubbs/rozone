import * as cp from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { LineFramer } from "./jsonLines.ts";

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; cwd?: string },
) => ChildProcess;

// Looked up as cp.spawn at call time so tests can replace it.
export const defaultSpawn: SpawnFn = (command, args, options) =>
  cp.spawn(command, [...args], { ...options, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });

export interface Hello {
  event: "hello";
  protocol: number;
  r_version?: string;
  packages?: Record<string, string>;
  missing: string[];
  ok: boolean;
}

export type SidecarErrorCode = "exit" | "timeout" | "protocol" | "remote" | "spawn" | "closed";

export class SidecarError extends Error {
  readonly code: SidecarErrorCode;
  constructor(code: SidecarErrorCode, message: string) {
    super(message);
    this.name = "SidecarError";
    this.code = code;
  }
}

export interface ExitInfo {
  code: number | null;
  signal: string | null;
  /** True when we asked the process to stop (shutdown/kill), false for crashes. */
  intentional: boolean;
  error?: Error;
}

export interface SidecarClientOptions {
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
  log: Logger;
  spawn?: SpawnFn;
  helloTimeoutMs?: number;
  requestTimeoutMs?: number;
  shutdownGraceMs?: number;
}

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class SidecarClient {
  #opts: SidecarClientOptions;
  #child: ChildProcess | undefined;
  #framer = new LineFramer();
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #hello: { resolve: (h: Hello) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> } | undefined;
  #exitInfo: ExitInfo | undefined;
  #stopping = false;
  #exitListeners = new Set<(info: ExitInfo) => void>();

  constructor(opts: SidecarClientOptions) {
    this.#opts = opts;
  }

  get running(): boolean {
    return this.#child !== undefined && this.#exitInfo === undefined;
  }

  onExit(listener: (info: ExitInfo) => void): () => void {
    this.#exitListeners.add(listener);
    return () => this.#exitListeners.delete(listener);
  }

  start(): Promise<Hello> {
    const { command, args, env, cwd, log } = this.#opts;
    const spawn = this.#opts.spawn ?? defaultSpawn;
    let child: ChildProcess;
    try {
      child = spawn(command, args, { env, cwd });
    } catch (error) {
      return Promise.reject(new SidecarError("spawn", `Failed to spawn ${command}: ${String(error)}`));
    }
    this.#child = child;
    log.info(`spawned ${command} ${args.join(" ")}`);

    child.stdout?.on("data", (chunk: Buffer | string) => {
      for (const line of this.#framer.push(chunk)) this.#onLine(line);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      for (const line of String(chunk).split(/\r?\n/)) if (line.trim() !== "") log.info(`[sidecar] ${line}`);
    });
    child.stdin?.on("error", (error: Error) => log.warn(`sidecar stdin error: ${error.message}`));
    child.on("error", (error: Error) => this.#finish({ code: null, signal: null, error }));
    child.on("close", (code: number | null, signal: string | null) => this.#finish({ code, signal }));

    return new Promise<Hello>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#hello = undefined;
        reject(new SidecarError("timeout", "Timed out waiting for the sidecar hello"));
        this.kill();
      }, this.#opts.helloTimeoutMs ?? 30_000);
      this.#hello = { resolve, reject, timer };
    });
  }

  request<T = unknown>(method: string, params: unknown = {}, timeoutMs?: number): Promise<T> {
    const stdin = this.#child?.stdin;
    if (!this.running || !stdin || stdin.destroyed || !stdin.writable) {
      return Promise.reject(new SidecarError("closed", "Sidecar is not running"));
    }
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new SidecarError("timeout", `Sidecar request '${method}' timed out`));
      }, timeoutMs ?? this.#opts.requestTimeoutMs ?? 60_000);
      this.#pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject, timer });
      stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (error) this.#settle(id, (p) => p.reject(new SidecarError("closed", error.message)));
      });
    });
  }

  /** Asks the sidecar to exit; falls back to a kill after the grace period. */
  async shutdown(): Promise<void> {
    if (!this.running) return;
    this.#stopping = true;
    const grace = this.#opts.shutdownGraceMs ?? 2_000;
    const exited = new Promise<void>((resolve) => {
      const off = this.onExit(() => {
        off();
        resolve();
      });
    });
    this.request("shutdown", {}, grace).catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), grace);
    });
    const winner = await Promise.race([exited.then(() => "exited" as const), deadline]);
    clearTimeout(timer);
    if (winner === "timeout") {
      this.#opts.log.warn("sidecar did not exit after shutdown; killing it");
      this.kill();
    }
  }

  kill(): void {
    if (this.#exitInfo) return;
    this.#stopping = true;
    this.#child?.kill("SIGKILL");
    this.#finish({ code: null, signal: "SIGKILL" });
  }

  #onLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.#opts.log.warn(`ignoring non-JSON sidecar output: ${line.slice(0, 200)}`);
      return;
    }
    if (typeof message !== "object" || message === null) {
      this.#opts.log.warn(`ignoring unexpected sidecar output: ${line.slice(0, 200)}`);
      return;
    }
    const record = message as Record<string, unknown>;
    if (record["event"] === "hello") {
      const hello = this.#hello;
      if (hello) {
        clearTimeout(hello.timer);
        this.#hello = undefined;
        hello.resolve({ missing: [], ...record } as unknown as Hello);
      }
      return;
    }
    const id = record["id"];
    if (typeof id !== "number") {
      this.#opts.log.warn(`ignoring sidecar message without id: ${line.slice(0, 200)}`);
      return;
    }
    const known = this.#settle(id, (pending) => {
      const error = record["error"];
      if (error !== undefined) {
        const text = typeof error === "object" && error !== null ? String((error as { message?: unknown }).message) : String(error);
        pending.reject(new SidecarError("remote", text));
      } else {
        pending.resolve(record["result"]);
      }
    });
    if (!known) this.#opts.log.warn(`response for unknown request id ${id} (probably timed out)`);
  }

  #settle(id: number, action: (pending: Pending) => void): boolean {
    const pending = this.#pending.get(id);
    if (!pending) return false;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    action(pending);
    return true;
  }

  #finish(partial: { code: number | null; signal: string | null; error?: Error }): void {
    if (this.#exitInfo) return;
    const info: ExitInfo = { ...partial, intentional: this.#stopping };
    this.#exitInfo = info;
    const reason = info.error?.message ?? `sidecar exited (code ${String(info.code)}, signal ${String(info.signal)})`;
    const hello = this.#hello;
    if (hello) {
      clearTimeout(hello.timer);
      this.#hello = undefined;
      hello.reject(new SidecarError(info.error ? "spawn" : "exit", reason));
    }
    for (const [id, pending] of [...this.#pending]) {
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(new SidecarError("exit", `${reason} while '${pending.method}' was pending`));
    }
    this.#opts.log.info(reason);
    for (const listener of [...this.#exitListeners]) listener(info);
  }
}
