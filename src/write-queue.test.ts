import { describe, expect, test } from "bun:test";

import { WriteQueue } from "./write-queue.ts";

/** A read-modify-write that yields between the read and the write, as a real one does. */
function counter(): { value: number; increment: () => Promise<void> } {
	const state = { value: 0 };

	return {
		get value(): number {
			return state.value;
		},
		increment: async (): Promise<void> => {
			const read = state.value;
			await Promise.resolve();
			state.value = read + 1;
		},
	};
}

describe("WriteQueue", () => {
	test("runs the work and answers with its result", async () => {
		const queue = new WriteQueue();

		expect(await queue.add(() => Promise.resolve("written"))).toBe("written");
	});

	test("loses no update when writers overlap", async () => {
		const queue = new WriteQueue();
		const state = counter();

		await Promise.all([
			queue.add(state.increment),
			queue.add(state.increment),
			queue.add(state.increment),
		]);

		expect(state.value).toBe(3);
	});

	test("runs the work in the order it was handed over", async () => {
		const queue = new WriteQueue();
		const order: string[] = [];
		const record = async (name: string): Promise<void> => {
			await Promise.resolve();
			order.push(name);
		};

		await Promise.all([
			queue.add(() => record("first")),
			queue.add(() => record("second")),
			queue.add(() => record("third")),
		]);

		expect(order).toEqual(["first", "second", "third"]);
	});

	/** One writer failing must not stop the queue, or a single bad write would wedge the hub. */
	test("keeps running after a piece of work fails", async () => {
		const queue = new WriteQueue();
		const state = counter();

		const failed = queue.add(() => Promise.reject(new Error("disk full")));

		await expect(failed).rejects.toThrow("disk full");
		await queue.add(state.increment);

		expect(state.value).toBe(1);
	});
});
