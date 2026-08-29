import { rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { asRecord } from "./json.ts";

export function stateFile(name: string): string {
  const base = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");

  return join(base, "backlog-browser", name);
}

/** Both state files hold one entry per root under a `roots` envelope; this reads it tolerantly. */
export async function readRoots(file: string): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await Bun.file(file).json();
  } catch {
    return {};
  }

  return asRecord(asRecord(parsed)?.roots) ?? {};
}

/**
 * Written beside and renamed over, so a crash mid-write cannot leave a half-written file. The pid
 * keeps two hubs from renaming each other's scratch out from underneath.
 */
export async function writeJson(file: string, value: unknown): Promise<void> {
  const scratch = `${file}.${process.pid}.tmp`;
  await Bun.write(scratch, `${JSON.stringify(value, null, 2)}\n`);
  await rename(scratch, file);
}
