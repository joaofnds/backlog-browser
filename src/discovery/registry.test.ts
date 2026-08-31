import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProjectRegistry } from "./registry.ts";

const DEPTH = 5;

let root: string;
let file: string;

async function makeProject(directory: string, name: string): Promise<string> {
	const path = join(root, directory);
	await Bun.write(
		join(path, "backlog", "config.yml"),
		`project_name: "${name}"\n`,
	);

	return path;
}

function registry(depth = DEPTH): ProjectRegistry {
	return new ProjectRegistry({ root, depth, file });
}

function namesOf(projects: readonly { name: string }[]): string[] {
	return projects.map((project) => project.name);
}

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "backlog-browser-registry-"));
	file = join(root, ".cache", "discovery.json");
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("ProjectRegistry", () => {
	describe("load", () => {
		test("scans when the cache is cold", async () => {
			await makeProject("alpha", "Alpha");

			expect(namesOf(await registry().load())).toEqual(["Alpha"]);
		});

		test("serves the saved scan, ignoring a project created since", async () => {
			await makeProject("alpha", "Alpha");
			await registry().load();

			await makeProject("beta", "Beta");

			expect(namesOf(await registry().load())).toEqual(["Alpha"]);
		});

		test("shows a project renamed since the scan", async () => {
			await makeProject("alpha", "Alpha");
			await registry().load();

			await makeProject("alpha", "Renamed");

			expect(namesOf(await registry().load())).toEqual(["Renamed"]);
		});

		test("drops a cached project that is gone", async () => {
			await makeProject("alpha", "Alpha");
			await makeProject("beta", "Beta");
			await registry().load();
			await rm(join(root, "alpha"), { recursive: true });

			expect(namesOf(await registry().load())).toEqual(["Beta"]);
		});

		describe("when the saved scan ran at another depth", () => {
			test("walks again, because a deeper walk reaches more", async () => {
				await makeProject("alpha", "Alpha");
				await registry(3).load();

				await makeProject("beta", "Beta");

				expect(namesOf(await registry(DEPTH).load())).toEqual([
					"Alpha",
					"Beta",
				]);
			});
		});

		describe("when the cache file is corrupt", () => {
			test("walks instead of failing", async () => {
				await makeProject("alpha", "Alpha");
				await Bun.write(file, "{ not json");

				expect(namesOf(await registry().load())).toEqual(["Alpha"]);
			});
		});
	});

	describe("refresh", () => {
		test("finds a project added since the scan", async () => {
			await makeProject("alpha", "Alpha");
			const subject = registry();
			await subject.load();

			await makeProject("beta", "Beta");

			expect(namesOf(await subject.refresh())).toEqual(["Alpha", "Beta"]);
		});

		test("saves the new scan for the next run", async () => {
			await makeProject("alpha", "Alpha");
			const subject = registry();
			await subject.load();
			await makeProject("beta", "Beta");
			await subject.refresh();

			expect(namesOf(await registry().load())).toEqual(["Alpha", "Beta"]);
		});
	});
});
