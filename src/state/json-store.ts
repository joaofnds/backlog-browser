import { homedir } from "node:os";
import { join } from "node:path";

export function stateFile(name: string): string {
  const base = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");

  return join(base, "backlog-browser", name);
}

export async function readJsonObject(file: string): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await Bun.file(file).json();
  } catch {
    return {};
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};

  return parsed as Record<string, unknown>;
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  await Bun.write(file, `${JSON.stringify(value, null, 2)}\n`);
}
