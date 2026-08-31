import { describe, expect, test } from "bun:test";

import { SETTING_BOUNDS } from "./settings.ts";
import { type StoredRoot, storedRootSchema } from "./stored.ts";

/** What the schema makes of one root's body, or nothing when it will not have it. */
function read(body: unknown): StoredRoot | undefined {
	const parsed = storedRootSchema.safeParse(body);

	return parsed.success ? parsed.data : undefined;
}

describe("a root of the state file", () => {
	test("keeps a root written by an earlier run", () => {
		const stored = read({
			active: "alpha-0badcafe",
			mode: "manual",
			order: ["/code/alpha"],
			hidden: ["/code/beta"],
			added: ["/code/gamma"],
			ports: { "/code/alpha": 6790 },
			settings: { depth: 4 },
		});

		expect(stored).toEqual({
			active: "alpha-0badcafe",
			mode: "manual",
			order: ["/code/alpha"],
			hidden: ["/code/beta"],
			added: ["/code/gamma"],
			ports: { "/code/alpha": 6790 },
			settings: { depth: 4 },
		});
	});

	/**
	 * The file is edited by hand and written by older versions, so a shape that does not fit is
	 * read as "nothing recorded" rather than thrown. Losing a preference beats refusing to start.
	 */
	describe("when the file cannot be trusted", () => {
		test("forgets an active project that is not a string", () => {
			expect(read({ active: 7 })?.active).toBeNull();
		});

		test("forgets an order mode it does not know", () => {
			expect(read({ mode: "sideways" })?.mode).toBe("default");
		});

		test("keeps only the string entries of a list", () => {
			const stored = read({ hidden: ["/a", 7, null] });

			expect(stored?.hidden).toEqual(["/a"]);
		});

		test("reads a list that is not an array as empty", () => {
			expect(read({ added: "/a" })?.added).toEqual([]);
		});

		test("drops a port outside the range a port can take", () => {
			const stored = read({ ports: { "/a": 0, "/b": 70_000, "/c": 6790 } });

			expect(stored?.ports).toEqual({ "/c": 6790 });
		});

		test("drops a port that is not a whole number", () => {
			const stored = read({ ports: { "/a": 1.5 } });

			expect(stored?.ports).toEqual({});
		});

		test("forgets a depth outside the range the setting allows", () => {
			const beyond = SETTING_BOUNDS.depth.maximum + 1;
			const stored = read({ settings: { depth: beyond } });

			expect(stored?.settings.depth).toBeNull();
		});
	});
});
