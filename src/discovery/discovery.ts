import { readdir, realpath } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { fieldOf } from "../json.ts";
import { Project } from "./project.ts";

const IGNORED_DIRECTORIES = new Set([
	"node_modules",
	".git",
	"target",
	"dist",
	"build",
	"vendor",
	".venv",
]);

export type ProjectFinder = (options: {
	root: string;
	depth: number;
}) => Promise<string[]>;

export const findProjectPaths: ProjectFinder = async (options) => {
	const found: string[] = [];
	const from = resolve(options.root);
	await collect(
		await realpath(from).catch(() => from),
		0,
		options.depth,
		found,
	);

	return found;
};

export async function readProjects(
	paths: readonly string[],
): Promise<Project[]> {
	const found = await Promise.all(paths.map(readProject));
	const byPath = new Map<string, Project>();
	for (const project of found) {
		if (project !== null) {
			byPath.set(project.path, project);
		}
	}

	return [...byPath.values()].sort(Project.byName);
}

/**
 * The path is followed to the directory it names, so a link and its target are one project. Both
 * the walk and the paths the user adds by hand arrive here, which is what keeps them agreeing:
 * a project is named by its real directory, whichever spelling reached us.
 */
export async function readProject(path: string): Promise<Project | null> {
	const name = await projectNameAt(path);
	if (name === null) {
		return null;
	}

	return new Project({ path: await realpath(path).catch(() => path), name });
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

	if (level >= maxDepth) {
		return;
	}

	for (const entry of await childDirectories(directory)) {
		await collect(join(directory, entry), level + 1, maxDepth, found);
	}
}

async function childDirectories(directory: string): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true }).catch(
		() => [],
	);

	return entries
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.filter((name) => !name.startsWith(".") && !IGNORED_DIRECTORIES.has(name));
}

async function projectNameAt(directory: string): Promise<string | null> {
	const config = Bun.file(join(directory, "backlog", "config.yml"));
	if (!(await config.exists())) {
		return null;
	}

	return (await declaredName(config)) ?? basename(directory);
}

async function declaredName(config: Bun.BunFile): Promise<string | null> {
	let parsed: unknown;
	try {
		parsed = Bun.YAML.parse(await config.text());
	} catch {
		return null;
	}

	const name = fieldOf(parsed, "project_name");

	return typeof name === "string" && name.trim() !== "" ? name.trim() : null;
}
