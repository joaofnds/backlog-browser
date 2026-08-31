import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProjectList } from "../list/list.ts";
import { StateStore } from "./store.ts";

const ROOT = "/code";
const OTHER_ROOT = "/work";
const ALPHA = "/code/alpha";
const BETA = "/code/beta";

let directory: string;
let file: string;

function storeAt(root = ROOT): StateStore {
	return new StateStore({ file, root });
}

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "backlog-browser-state-"));
	file = join(directory, "nested", "state.json");
});

afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

describe("StateStore", () => {
	test("remembers nothing before a project is activated", async () => {
		expect(await storeAt().lastActive()).toBeNull();
	});

	test("returns the last remembered project", async () => {
		const store = storeAt();

		await store.remember("alpha-1234abcd");

		expect(await store.lastActive()).toEqual("alpha-1234abcd");
	});

	test("keeps only the most recent project", async () => {
		const store = storeAt();

		await store.remember("alpha-1234abcd");
		await store.remember("beta-5678efgh");

		expect(await store.lastActive()).toEqual("beta-5678efgh");
	});

	test("carries the project across hub restarts", async () => {
		await storeAt().remember("alpha-1234abcd");

		expect(await storeAt().lastActive()).toEqual("alpha-1234abcd");
	});

	test("keeps one project per root", async () => {
		await storeAt(ROOT).remember("alpha-1234abcd");
		await storeAt(OTHER_ROOT).remember("beta-5678efgh");

		expect(await storeAt(ROOT).lastActive()).toEqual("alpha-1234abcd");
	});

	test("remembers nothing for a root that was never opened", async () => {
		await storeAt(ROOT).remember("alpha-1234abcd");

		expect(await storeAt(OTHER_ROOT).lastActive()).toBeNull();
	});

	describe("the project list", () => {
		test("starts empty for a root that was never opened", async () => {
			expect(await storeAt().list()).toEqual(ProjectList.empty());
		});

		test("carries the list across hub restarts", async () => {
			const list = ProjectList.empty().hide(ALPHA);

			await storeAt().updateList(() => list);

			expect(await storeAt().list()).toEqual(list);
		});

		test("keeps one list per root", async () => {
			await storeAt(ROOT).updateList((list) => list.hide(ALPHA));

			expect(await storeAt(OTHER_ROOT).list()).toEqual(ProjectList.empty());
		});

		test("survives activating a project", async () => {
			const store = storeAt();
			const list = ProjectList.empty().hide(ALPHA);

			await store.updateList(() => list);
			await store.remember("beta-5678efgh");

			expect(await store.list()).toEqual(list);
		});

		test("leaves the remembered project alone", async () => {
			const store = storeAt();

			await store.remember("alpha-1234abcd");
			await store.updateList((list) => list.hide(ALPHA));

			expect(await store.lastActive()).toEqual("alpha-1234abcd");
		});

		test("loses neither write when both land at once", async () => {
			const store = storeAt();
			const list = ProjectList.empty().hide(ALPHA);

			await Promise.all([
				store.remember("alpha-1234abcd"),
				store.updateList(() => list),
			]);

			expect(await store.lastActive()).toEqual("alpha-1234abcd");
			expect(await store.list()).toEqual(list);
		});
	});

	describe("remembered ports", () => {
		test("knows no port for a project it has never seen", async () => {
			expect(await storeAt().portFor(ALPHA)).toBeNull();
		});

		test("hands back the port a project was given", async () => {
			const store = storeAt();

			await store.rememberPort(ALPHA, 40_001);

			expect(await store.portFor(ALPHA)).toEqual(40_001);
		});

		test("keeps one port per project", async () => {
			const store = storeAt();

			await store.rememberPort(ALPHA, 40_001);
			await store.rememberPort(BETA, 40_002);

			expect(await store.portFor(ALPHA)).toEqual(40_001);
		});

		test("replaces a project's port when it is assigned again", async () => {
			const store = storeAt();

			await store.rememberPort(ALPHA, 40_001);
			await store.rememberPort(ALPHA, 40_002);

			expect(await store.portFor(ALPHA)).toEqual(40_002);
		});

		test("carries the ports across hub restarts", async () => {
			await storeAt().rememberPort(ALPHA, 40_001);

			expect(await storeAt().portFor(ALPHA)).toEqual(40_001);
		});

		test("keeps one set of ports per root", async () => {
			await storeAt(ROOT).rememberPort(ALPHA, 40_001);

			expect(await storeAt(OTHER_ROOT).portFor(ALPHA)).toBeNull();
		});

		test("survives activating a project", async () => {
			const store = storeAt();

			await store.rememberPort(ALPHA, 40_001);
			await store.remember("beta-5678efgh");

			expect(await store.portFor(ALPHA)).toEqual(40_001);
		});

		test("leaves the list alone", async () => {
			const store = storeAt();
			const list = ProjectList.empty().hide(ALPHA);

			await store.updateList(() => list);
			await store.rememberPort(BETA, 40_002);

			expect(await store.list()).toEqual(list);
		});

		test("loses neither write when both land at once", async () => {
			const store = storeAt();

			await Promise.all([
				store.rememberPort(ALPHA, 40_001),
				store.rememberPort(BETA, 40_002),
			]);

			expect(await store.portFor(ALPHA)).toEqual(40_001);
			expect(await store.portFor(BETA)).toEqual(40_002);
		});

		test.each([["not a number"], [0], [70_000], [40_001.5], [null]])(
			"drops %p stored as a port",
			async (stored) => {
				await Bun.write(
					file,
					JSON.stringify({ roots: { [ROOT]: { ports: { [ALPHA]: stored } } } }),
				);

				expect(await storeAt().portFor(ALPHA)).toBeNull();
			},
		);
	});

	describe("the remembered depth", () => {
		test("starts unchosen for a root that was never opened", async () => {
			expect(await storeAt().depth()).toBeNull();
		});

		test("carries the depth across hub restarts", async () => {
			await storeAt().rememberDepth(7);

			expect(await storeAt().depth()).toEqual(7);
		});

		test("keeps one depth per root", async () => {
			await storeAt(ROOT).rememberDepth(7);

			expect(await storeAt(OTHER_ROOT).depth()).toBeNull();
		});

		test("survives activating a project", async () => {
			const store = storeAt();

			await store.rememberDepth(7);
			await store.remember("alpha-1234abcd");

			expect(await store.depth()).toEqual(7);
		});

		test("drops a stored depth outside the settable bounds", async () => {
			await Bun.write(
				file,
				JSON.stringify({ roots: { [ROOT]: { settings: { depth: 999 } } } }),
			);

			expect(await storeAt().depth()).toBeNull();
		});
	});

	describe("when the state file is corrupt", () => {
		test("remembers nothing", async () => {
			await Bun.write(file, "{ not json");

			expect(await storeAt().lastActive()).toBeNull();
		});

		test("recovers on the next write", async () => {
			await Bun.write(file, "{ not json");
			const store = storeAt();

			await store.remember("alpha-1234abcd");

			expect(await store.lastActive()).toEqual("alpha-1234abcd");
		});
	});
});
