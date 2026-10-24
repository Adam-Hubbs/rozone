export const SPAWN_LOG_KEY = "__rozoneSpawnLog";

export interface SpawnCall {
  method: string;
  command: string;
  stack: string;
  at: number;
}

export function spawnLog(): SpawnCall[] {
  const log = (globalThis as unknown as Record<string, SpawnCall[] | undefined>)[SPAWN_LOG_KEY];
  if (!log) throw new Error("spawn spy is not installed; the config must `require` spawnSpy.setup.cjs");
  return log;
}

/** Calls whose stack passes through rozone's own bundles (the extension and its worker). */
export function spawnsFromRozone(): SpawnCall[] {
  return spawnLog().filter((call) => /[\\/]dist[\\/](extension|worker)\.cjs/.test(call.stack));
}
