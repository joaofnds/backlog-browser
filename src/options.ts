import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { SETTING_BOUNDS, type SettingBounds } from "./state/settings.ts";

export const DEFAULTS = {
  port: 6789,
  depth: 5,
  maxChildren: 5,
  idleTimeoutMinutes: 30,
} as const;

export const USAGE = `Usage: backlog-browser [root]

One local board for every Backlog.md project under a folder.

Options:
  --port <n>           hub port (default ${DEFAULTS.port})
  --depth <n>          discovery depth (default ${DEFAULTS.depth}, remembered per root)
  --max-children <n>   warm child servers (default ${DEFAULTS.maxChildren}, remembered per root)
  --idle-timeout <m>   minutes before a child is stopped (default ${DEFAULTS.idleTimeoutMinutes}, 0 = never)
  --rescan             walk the tree at startup instead of using the cache
  --no-open            do not open the browser
  -h, --help           show this message`;

export type HubOptions = {
  root: string;
  port: number;
  depth: number | null;
  maxChildren: number | null;
  idleTimeoutMs: number;
  rescan: boolean;
  open: boolean;
};

export class UsageError extends Error {}

export function parseOptions(argv: string[]): HubOptions {
  const { values, positionals } = read(argv);

  if (positionals.length > 1) {
    throw new UsageError(`Expected at most one root directory, got ${positionals.length}.`);
  }

  return {
    root: expand(positionals[0] ?? process.cwd()),
    port: numeric("--port", values.port, DEFAULTS.port, 1),
    depth: bounded("--depth", values.depth, SETTING_BOUNDS.depth),
    maxChildren: bounded("--max-children", values["max-children"], SETTING_BOUNDS.maxChildren),
    idleTimeoutMs:
      numeric("--idle-timeout", values["idle-timeout"], DEFAULTS.idleTimeoutMinutes, 0) * 60_000,
    rescan: values.rescan === true,
    open: values.open !== false,
  };
}

function read(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      allowNegative: true,
      options: {
        port: { type: "string" },
        depth: { type: "string" },
        "max-children": { type: "string" },
        "idle-timeout": { type: "string" },
        rescan: { type: "boolean", default: false },
        open: { type: "boolean", default: true },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (cause) {
    throw new UsageError(`${(cause as Error).message}\n\n${USAGE}`);
  }
}

export function wantsHelp(argv: string[]): boolean {
  return argv.includes("--help") || argv.includes("-h");
}

/** `null` is "the flag was absent", which is what lets a value chosen in the shell survive. */
function bounded(flag: string, raw: string | undefined, bounds: SettingBounds): number | null {
  if (raw === undefined) return null;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < bounds.minimum || value > bounds.maximum) {
    throw new UsageError(
      `${flag} expects a whole number between ${bounds.minimum} and ${bounds.maximum}, got "${raw}".`,
    );
  }

  return value;
}

function numeric(flag: string, raw: string | undefined, fallback: number, minimum: number): number {
  if (raw === undefined) return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum) {
    throw new UsageError(`${flag} expects a whole number of at least ${minimum}, got "${raw}".`);
  }

  return value;
}

function expand(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));

  return resolve(path);
}
