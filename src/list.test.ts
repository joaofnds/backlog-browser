import { describe, expect, test } from "bun:test";

import { Project } from "./project.ts";
import { EMPTY_ROOT } from "./stored.ts";
import { ProjectList } from "./list.ts";

const alpha = new Project({ path: "/code/alpha", name: "Alpha" });
const beta = new Project({ path: "/code/beta", name: "Beta" });
const gamma = new Project({ path: "/code/gamma", name: "Gamma" });

const discovered = [alpha, beta, gamma];

function pathsOf(listed: readonly { readonly project: Project }[]): string[] {
	return listed.map((entry) => entry.project.path);
}

function visiblePathsOf(
	listed: readonly { readonly project: Project; readonly hidden: boolean }[],
): string[] {
	return pathsOf(listed.filter((entry) => !entry.hidden));
}

describe("ProjectList", () => {
	describe("arrange", () => {
		test("keeps the discovered order while the list is in default mode", () => {
			expect(pathsOf(ProjectList.empty().arrange(discovered))).toEqual([
				"/code/alpha",
				"/code/beta",
				"/code/gamma",
			]);
		});

		test("flags a hidden project and sinks it below the visible ones", () => {
			const list = ProjectList.empty().hide("/code/alpha");

			const arranged = list.arrange(discovered);

			expect(visiblePathsOf(arranged)).toEqual(["/code/beta", "/code/gamma"]);
			expect(pathsOf(arranged)).toEqual([
				"/code/beta",
				"/code/gamma",
				"/code/alpha",
			]);
		});

		test("follows the stored order in manual mode", () => {
			const list = new ProjectList({
				mode: "manual",
				order: ["/code/gamma", "/code/alpha", "/code/beta"],
				hidden: [],
				added: [],
			});

			expect(pathsOf(list.arrange(discovered))).toEqual([
				"/code/gamma",
				"/code/alpha",
				"/code/beta",
			]);
		});

		test("appends a project the stored order does not know", () => {
			const list = new ProjectList({
				mode: "manual",
				order: ["/code/gamma", "/code/beta"],
				hidden: [],
				added: [],
			});

			expect(pathsOf(list.arrange(discovered))).toEqual([
				"/code/gamma",
				"/code/beta",
				"/code/alpha",
			]);
		});

		test("appends several unknown projects by name", () => {
			const list = new ProjectList({
				mode: "manual",
				order: ["/code/gamma"],
				hidden: [],
				added: [],
			});

			expect(pathsOf(list.arrange(discovered))).toEqual([
				"/code/gamma",
				"/code/alpha",
				"/code/beta",
			]);
		});

		test("leaves out a stored path the walk did not find", () => {
			const list = new ProjectList({
				mode: "manual",
				order: ["/code/gone", "/code/alpha"],
				hidden: ["/code/vanished"],
				added: [],
			});

			expect(pathsOf(list.arrange([alpha]))).toEqual(["/code/alpha"]);
		});
	});

	describe("hide", () => {
		test("marks the project hidden", () => {
			const list = ProjectList.empty().hide("/code/alpha");

			expect(list.hidden).toEqual(["/code/alpha"]);
		});

		test("drops the project from the manual order", () => {
			const list = new ProjectList({
				mode: "manual",
				order: ["/code/alpha", "/code/beta"],
				hidden: [],
				added: [],
			});

			expect(list.hide("/code/alpha").order).toEqual(["/code/beta"]);
		});

		test("hides a project already hidden without duplicating it", () => {
			const list = ProjectList.empty().hide("/code/alpha").hide("/code/alpha");

			expect(list.hidden).toEqual(["/code/alpha"]);
		});
	});

	describe("show", () => {
		test("clears the hidden mark", () => {
			const list = ProjectList.empty().hide("/code/alpha").show("/code/alpha");

			expect(list.hidden).toEqual([]);
		});

		test("returns the project to its name slot in default mode", () => {
			const list = ProjectList.empty().hide("/code/alpha").show("/code/alpha");

			expect(pathsOf(list.arrange(discovered))).toEqual([
				"/code/alpha",
				"/code/beta",
				"/code/gamma",
			]);
		});

		test("drops the project at the end of a manual order", () => {
			const list = new ProjectList({
				mode: "manual",
				order: ["/code/alpha", "/code/beta", "/code/gamma"],
				hidden: [],
				added: [],
			})
				.hide("/code/alpha")
				.show("/code/alpha");

			expect(pathsOf(list.arrange(discovered))).toEqual([
				"/code/beta",
				"/code/gamma",
				"/code/alpha",
			]);
		});
	});

	describe("move", () => {
		test("switches the list to manual mode", () => {
			const list = ProjectList.empty().move({
				path: "/code/gamma",
				before: "/code/alpha",
				discovered,
			});

			expect(list.mode).toEqual("manual");
		});

		test("seeds the order from the discovered order on the first move", () => {
			const list = ProjectList.empty().move({
				path: "/code/gamma",
				before: "/code/alpha",
				discovered,
			});

			expect(list.order).toEqual(["/code/gamma", "/code/alpha", "/code/beta"]);
		});

		test("moves the project to the end when nothing follows it", () => {
			const list = ProjectList.empty().move({
				path: "/code/alpha",
				before: null,
				discovered,
			});

			expect(list.order).toEqual(["/code/beta", "/code/gamma", "/code/alpha"]);
		});

		test("keeps a stored path the walk did not find", () => {
			const list = new ProjectList({
				mode: "manual",
				order: ["/code/alpha", "/code/gone", "/code/beta"],
				hidden: [],
				added: [],
			});

			expect(
				list.move({ path: "/code/beta", before: "/code/alpha", discovered })
					.order,
			).toEqual(["/code/beta", "/code/alpha", "/code/gone"]);
		});

		test("leaves the order untouched when the anchor is unknown", () => {
			const list = new ProjectList({
				mode: "manual",
				order: ["/code/alpha", "/code/beta"],
				hidden: [],
				added: [],
			});

			expect(
				list.move({ path: "/code/alpha", before: "/code/nowhere", discovered })
					.order,
			).toEqual(["/code/alpha", "/code/beta"]);
		});

		test("ignores a hidden project", () => {
			const list = ProjectList.empty().hide("/code/alpha");

			expect(
				list.move({ path: "/code/alpha", before: "/code/beta", discovered }),
			).toEqual(list);
		});
	});

	describe("reset", () => {
		test("returns the list to default mode", () => {
			const list = ProjectList.empty()
				.move({ path: "/code/gamma", before: "/code/alpha", discovered })
				.reset();

			expect(list.mode).toEqual("default");
		});

		test("forgets the manual order", () => {
			const list = ProjectList.empty()
				.move({ path: "/code/gamma", before: "/code/alpha", discovered })
				.reset();

			expect(list.order).toEqual([]);
		});

		test("keeps hidden projects hidden", () => {
			const list = ProjectList.empty().hide("/code/alpha").reset();

			expect(list.hidden).toEqual(["/code/alpha"]);
		});
	});

	describe("from", () => {
		/** Tolerance for a garbled file belongs to the schema; see `stored.test.ts` for that. */
		test("carries the recorded list across", () => {
			const list = ProjectList.from({
				...EMPTY_ROOT,
				mode: "manual",
				order: ["/code/beta"],
				hidden: ["/code/alpha"],
			});

			expect(list).toEqual(
				new ProjectList({
					mode: "manual",
					order: ["/code/beta"],
					hidden: ["/code/alpha"],
					added: [],
				}),
			);
		});

		test("is an empty list when nothing was recorded", () => {
			expect(ProjectList.from(EMPTY_ROOT)).toEqual(ProjectList.empty());
		});
	});
});
