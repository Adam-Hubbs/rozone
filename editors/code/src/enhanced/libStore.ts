import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Logger } from "./sidecarClient.ts";

const LIB_DIR = /^lib-[0-9]+$/;
export const DAY_MS = 24 * 60 * 60 * 1000;

export function sanitizeSessionId(sessionId: string): string {
  const safe = sessionId.replaceAll(/[^A-Za-z0-9._-]/g, "_");
  return safe === "" || safe === "." || safe === ".." ? "_" : safe;
}

/** Owns the on-disk generated libraries: `<root>/<sessionId>/lib-<N>`. Cleanup never throws. */
export class LibStore {
  #root: string;
  #log: Logger;

  constructor(root: string, log: Logger) {
    this.#root = root;
    this.#log = log;
  }

  sessionRoot(sessionId: string): string {
    return path.join(this.#root, sanitizeSessionId(sessionId));
  }

  /** Deletes every `lib-*` folder of the session except `keepLibDir`. */
  async prune(sessionId: string, keepLibDir: string): Promise<void> {
    const dir = this.sessionRoot(sessionId);
    const keep = path.resolve(keepLibDir);
    try {
      for (const name of await listDirs(dir, (n) => LIB_DIR.test(n))) {
        const full = path.join(dir, name);
        if (path.resolve(full) !== keep) await this.#rm(full);
      }
    } catch (error) {
      this.#warn(dir, error);
    }
  }

  async remove(sessionId: string): Promise<void> {
    await this.#rm(this.sessionRoot(sessionId));
  }

  /** Deletes session folders that are not live and have not been touched for `maxAgeMs`. */
  async sweep(liveIds: readonly string[], now: number, maxAgeMs: number = DAY_MS): Promise<void> {
    const live = new Set(liveIds.map(sanitizeSessionId));
    await this.#sweepDirs(this.#root, (name) => !live.has(name), now, maxAgeMs);
  }

  /** One-time cleanup of the old layout, where `lib-*` lived directly in the global storage folder. */
  async cleanLegacy(globalRoot: string, now: number, maxAgeMs: number = DAY_MS): Promise<void> {
    await this.#sweepDirs(globalRoot, (name) => LIB_DIR.test(name), now, maxAgeMs);
  }

  async #sweepDirs(root: string, eligible: (name: string) => boolean, now: number, maxAgeMs: number): Promise<void> {
    try {
      for (const name of await listDirs(root, eligible)) {
        const full = path.join(root, name);
        try {
          const { mtimeMs } = await fs.stat(full);
          if (now - mtimeMs > maxAgeMs) await this.#rm(full);
        } catch (error) {
          this.#warn(full, error);
        }
      }
    } catch (error) {
      this.#warn(root, error);
    }
  }

  async #rm(target: string): Promise<void> {
    try {
      await fs.rm(target, { recursive: true, force: true });
    } catch (error) {
      this.#warn(target, error);
    }
  }

  #warn(target: string, error: unknown): void {
    this.#log.warn(`could not clean ${target}: ${String(error)}`);
  }
}

async function listDirs(dir: string, accept: (name: string) => boolean): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && accept(e.name)).map((e) => e.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
