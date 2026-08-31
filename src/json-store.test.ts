import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { readRoots, writeJson } from "./json-store.ts";
import type { Json } from "./json.ts";

const body = z.object({ kept: z.string() });

let directory: string;
let file: string;

beforeEach(async () => {
	directory = await realpath(await mkdtemp(join(tmpdir(), "backlog-browser-")));
	file = join(directory, "state.json");
});

afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

async function write(document: Json): Promise<void> {
	await writeJson(file, document);
}

/** Bytes that are not a document at all, which `writeJson` would refuse to be given. */
async function writeRaw(bytes: string): Promise<void> {
	await Bun.write(file, bytes);
}

describe("reading the roots of a state file", () => {
	test("reads back what was written", async () => {
		await write({ roots: { "/code": { kept: "yes" } } });

		expect(await readRoots(file, body)).toEqual({ "/code": { kept: "yes" } });
	});

	/**
	 * These files are written by older versions of the tool and edited by hand, so an unreadable
	 * one means "nothing recorded" rather than a crash: a lost preference beats a hub that will
	 * not start.
	 */
	describe("when the file cannot be trusted", () => {
		test("reads no roots when the file is not there", async () => {
			expect(await readRoots(join(directory, "absent.json"), body)).toEqual({});
		});

		test("reads no roots from bytes that are not JSON", async () => {
			await writeRaw("{ truncated");

			expect(await readRoots(file, body)).toEqual({});
		});

		test("reads no roots from a document that is not an object", async () => {
			await write("nonsense");

			expect(await readRoots(file, body)).toEqual({});
		});

		test("reads no roots when the envelope is missing", async () => {
			await write({});

			expect(await readRoots(file, body)).toEqual({});
		});

		test("keeps the roots it can read and drops the one it cannot", async () => {
			await write({ roots: { "/code": { kept: "yes" }, "/work": 7 } });

			expect(await readRoots(file, body)).toEqual({ "/code": { kept: "yes" } });
		});
	});

	/** A crash mid-write must not leave a half-written file where a whole one was. */
	test("leaves no scratch file behind", async () => {
		await write({ roots: {} });

		expect(
			await Array.fromAsync(new Bun.Glob("*.tmp").scan(directory)),
		).toEqual([]);
	});
});
