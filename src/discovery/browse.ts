import { readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { isProject } from "./discovery.ts";

export type DirectoryEntry = {
  readonly name: string;
  readonly path: string;
  readonly project: boolean;
};

export type DirectoryListing = {
  readonly path: string;
  readonly parent: string | null;
  readonly project: boolean;
  readonly entries: readonly DirectoryEntry[];
};

/**
 * One level, never a walk. Reaching a project nested below the discovery depth is the whole point,
 * and paying for a deep walk to offer that is the cost this avoids.
 */
export async function browse(path: string): Promise<DirectoryListing | null> {
  const directory = resolve(path);

  const found = await readdir(directory, { withFileTypes: true }).catch(() => null);
  if (found === null) return null;

  const names = found
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  const parent = dirname(directory);

  return {
    path: directory,
    parent: parent === directory ? null : parent,
    project: await isProject(directory),
    entries: await Promise.all(names.map((name) => describe(directory, name))),
  };
}

async function describe(directory: string, name: string): Promise<DirectoryEntry> {
  const path = join(directory, name);

  return { name, path, project: await isProject(path) };
}
