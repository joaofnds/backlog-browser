import { readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { Project } from "./project.ts";

export const DEFAULT_DEPTH = 5;

const IGNORED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  "target",
  "dist",
  "build",
  "vendor",
  ".venv",
]);

export type ProjectFinder = (options: { root: string; depth: number }) => Promise<string[]>;

export async function discoverProjects(options: {
  root: string;
  depth?: number;
}): Promise<Project[]> {
  return readProjects(
    await findProjectPaths({ root: options.root, depth: options.depth ?? DEFAULT_DEPTH }),
  );
}

export const findProjectPaths: ProjectFinder = async (options) => {
  const found: string[] = [];
  await collect(resolve(options.root), 0, options.depth, found);

  return found;
};

export async function readProjects(paths: readonly string[]): Promise<Project[]> {
  const found = await Promise.all(paths.map(readProject));

  return found.filter((project) => project !== null).sort(Project.byName);
}

export async function isProject(directory: string): Promise<boolean> {
  return Bun.file(join(directory, "backlog", "config.yml")).exists();
}

export async function readProject(path: string): Promise<Project | null> {
  const name = await projectNameAt(path);

  return name === null ? null : new Project({ path, name });
}

async function collect(
  directory: string,
  level: number,
  maxDepth: number,
  found: string[],
): Promise<void> {
  if ((await projectNameAt(directory)) !== null) {
    found.push(directory);
    return;
  }

  if (level >= maxDepth) return;

  for (const entry of await childDirectories(directory)) {
    await collect(join(directory, entry), level + 1, maxDepth, found);
  }
}

async function childDirectories(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith(".") && !IGNORED_DIRECTORIES.has(name));
}

async function projectNameAt(directory: string): Promise<string | null> {
  const config = Bun.file(join(directory, "backlog", "config.yml"));
  if (!(await config.exists())) return null;

  return (await declaredName(config)) ?? basename(directory);
}

async function declaredName(config: Bun.BunFile): Promise<string | null> {
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(await config.text());
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;

  const name = (parsed as Record<string, unknown>).project_name;

  return typeof name === "string" && name.trim() !== "" ? name.trim() : null;
}
