import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakePortSpace } from "./fake-port-space.ts";
import type { PortAllocator } from "./supervisor.ts";
import { rememberedPorts } from "./remembered-ports.ts";
import { StateStore } from "./store.ts";

const ROOT = "/code";
const ALPHA = "/code/alpha";
const BETA = "/code/beta";

let directory: string;
let file: string;
let kernel: FakePortSpace;

function hubRun(root = ROOT): PortAllocator {
	return rememberedPorts({
		store: new StateStore({ file, root }),
		allocate: kernel.allocate,
	});
}

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "backlog-browser-ports-"));
	file = join(directory, "state.json");
	kernel = new FakePortSpace();
});

afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

describe("rememberedPorts", () => {
	test("asks the kernel for a port a project has never had", async () => {
		expect(await hubRun()({ path: ALPHA, reuse: true })).toEqual(40_001);
	});

	test("gives each project its own port", async () => {
		const ports = hubRun();

		await ports({ path: ALPHA, reuse: true });

		expect(await ports({ path: BETA, reuse: true })).toEqual(40_002);
	});

	test("hands the same port back within one hub run", async () => {
		const ports = hubRun();
		const first = await ports({ path: ALPHA, reuse: true });

		expect(await ports({ path: ALPHA, reuse: true })).toEqual(first);
	});

	test("hands the same port back in a later hub run", async () => {
		const first = await hubRun()({ path: ALPHA, reuse: true });

		expect(await hubRun()({ path: ALPHA, reuse: true })).toEqual(first);
	});

	test("keeps one port per root", async () => {
		const first = await hubRun()({ path: ALPHA, reuse: true });

		expect(await hubRun("/work")({ path: ALPHA, reuse: true })).not.toEqual(
			first,
		);
	});

	describe("when the remembered port cannot be had", () => {
		test("falls back to a fresh one", async () => {
			const first = await hubRun()({ path: ALPHA, reuse: true });
			kernel.occupy(first);

			expect(await hubRun()({ path: ALPHA, reuse: true })).not.toEqual(first);
		});

		test("remembers the port it fell back to", async () => {
			const first = await hubRun()({ path: ALPHA, reuse: true });
			kernel.occupy(first);
			const second = await hubRun()({ path: ALPHA, reuse: true });

			expect(await hubRun()({ path: ALPHA, reuse: true })).toEqual(second);
		});
	});

	describe("when reuse is off", () => {
		test("asks the kernel for a fresh port", async () => {
			const ports = hubRun();
			const first = await ports({ path: ALPHA, reuse: true });

			expect(await ports({ path: ALPHA, reuse: false })).not.toEqual(first);
		});

		test("remembers the fresh port instead", async () => {
			const ports = hubRun();
			await ports({ path: ALPHA, reuse: true });
			const second = await ports({ path: ALPHA, reuse: false });

			expect(await ports({ path: ALPHA, reuse: true })).toEqual(second);
		});
	});
});
