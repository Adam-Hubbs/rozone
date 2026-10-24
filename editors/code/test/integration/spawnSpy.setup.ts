// Loaded through mocha's `require` before any suite, i.e. before the tests run and, in practice,
// before or right as the extension activates. The extension reaches child_process only through
// namespace member access at call time, so replacing the members on the shared module is enough.
import cp from "node:child_process";
import { SPAWN_LOG_KEY, type SpawnCall } from "./spawnLog.ts";

const METHODS = ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"] as const;

type Target = Record<string, (...args: unknown[]) => unknown>;

function describe(args: unknown[]): string {
  return args
    .slice(0, 2)
    .map((arg) => (Array.isArray(arg) ? arg.join(" ") : typeof arg === "string" ? arg : ""))
    .join(" ")
    .trim();
}

const holder = globalThis as unknown as Record<string, SpawnCall[] | undefined>;

if (!holder[SPAWN_LOG_KEY]) {
  const log: SpawnCall[] = [];
  holder[SPAWN_LOG_KEY] = log;
  const target = cp as unknown as Target;
  for (const method of METHODS) {
    const original = target[method];
    if (!original) continue;
    target[method] = function (this: unknown, ...args: unknown[]) {
      const previousLimit = Error.stackTraceLimit;
      Error.stackTraceLimit = 80;
      const stack = new Error().stack ?? "";
      Error.stackTraceLimit = previousLimit;
      log.push({ method, command: describe(args), stack, at: Date.now() });
      return original.apply(this, args);
    };
  }
}
