import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { parseOptions, UsageError } from "./options.ts";

describe("parseOptions", () => {
	test("defaults the root to the current directory", () => {
		expect(parseOptions([]).root).toEqual(process.cwd());
	});

	test("takes the root from the first positional argument", () => {
		expect(parseOptions(["./somewhere"]).root).toEqual(resolve("./somewhere"));
	});

	test("expands a home-relative root", () => {
		expect(parseOptions(["~/code"]).root).toEqual(join(homedir(), "code"));
	});

	test("defaults every tunable it owns", () => {
		expect(parseOptions([])).toMatchObject({
			port: 6789,
			idleTimeoutMs: 5 * 60_000,
			rescan: false,
			open: true,
		});
	});

	test("leaves the remembered depth unset when its flag is absent", () => {
		expect(parseOptions([])).toMatchObject({ depth: null });
	});

	test("overrides the hub port", () => {
		expect(parseOptions(["--port", "7000"]).port).toEqual(7000);
	});

	test("overrides the discovery depth", () => {
		expect(parseOptions(["--depth", "5"]).depth).toEqual(5);
	});

	test("reads the idle timeout as minutes", () => {
		expect(parseOptions(["--idle-timeout", "2"]).idleTimeoutMs).toEqual(
			120_000,
		);
	});

	test("disables idle shutdown at zero", () => {
		expect(parseOptions(["--idle-timeout", "0"]).idleTimeoutMs).toEqual(0);
	});

	test("forces a fresh walk with --rescan", () => {
		expect(parseOptions(["--rescan"]).rescan).toBe(true);
	});

	test("keeps the browser closed with --no-open", () => {
		expect(parseOptions(["--no-open"]).open).toBe(false);
	});

	test("accepts flags before the root", () => {
		expect(parseOptions(["--port", "7000", "/tmp"])).toMatchObject({
			port: 7000,
			root: "/tmp",
		});
	});

	describe("when a numeric flag is not a number", () => {
		test("rejects naming the flag", () => {
			expect(() => parseOptions(["--port", "http"])).toThrow(UsageError);
			expect(() => parseOptions(["--port", "http"])).toThrow(/--port/);
		});
	});

	describe("when a numeric flag is out of range", () => {
		test("rejects a depth below one", () => {
			expect(() => parseOptions(["--depth", "0"])).toThrow(/--depth/);
		});

		test("rejects a depth above the settings ceiling", () => {
			expect(() => parseOptions(["--depth", "21"])).toThrow(/--depth/);
		});

		test("rejects a negative idle timeout", () => {
			expect(() => parseOptions(["--idle-timeout", "-1"])).toThrow(
				/--idle-timeout/,
			);
		});
	});

	describe("when the flag is unknown", () => {
		test("rejects naming the usage", () => {
			expect(() => parseOptions(["--turbo"])).toThrow(UsageError);
		});
	});

	describe("when more than one root is given", () => {
		test("rejects", () => {
			expect(() => parseOptions(["/tmp", "/var"])).toThrow(UsageError);
		});
	});
});
