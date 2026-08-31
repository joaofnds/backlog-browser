import { describe, expect, test } from "bun:test";

import { Project } from "./project.ts";

function projectAt(path: string, name = "Any Name"): Project {
	return new Project({ path, name });
}

describe("Project", () => {
	describe("slug", () => {
		test("is url-safe", () => {
			const project = projectAt("/Users/joao/code/My Project (2024)!");

			expect(project.slug).toMatch(/^[a-z0-9-]+$/u);
			expect(encodeURIComponent(project.slug)).toEqual(project.slug);
		});

		test("is stable for the same path", () => {
			expect(projectAt("/code/alpha").slug).toEqual(
				projectAt("/code/alpha").slug,
			);
		});

		test("survives a rename of the project", () => {
			const before = projectAt("/code/alpha", "Alpha");
			const after = projectAt("/code/alpha", "Renamed Alpha");

			expect(after.slug).toEqual(before.slug);
		});

		test("distinguishes two projects that share a directory name", () => {
			const work = projectAt("/code/work/alpha");
			const play = projectAt("/code/play/alpha");

			expect(work.slug).not.toEqual(play.slug);
		});

		test("keeps the directory name readable", () => {
			expect(projectAt("/code/template-ops").slug).toStartWith("template-ops-");
		});
	});

	describe("byName", () => {
		test("orders case-insensitively", () => {
			const sorted = [
				projectAt("/a", "banana"),
				projectAt("/b", "Apple"),
			].toSorted((left, right) => Project.byName(left, right));

			expect(sorted.map((project) => project.name)).toEqual([
				"Apple",
				"banana",
			]);
		});
	});
});
