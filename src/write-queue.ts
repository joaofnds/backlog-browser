/**
 * Runs work one piece at a time, in the order it was handed over.
 *
 * A read-modify-write of a whole file loses an update when two of them overlap, and this hub has
 * several writers: activating a project, reordering the list, claiming a port. Queueing them makes
 * each read the state the one before it left.
 *
 * The tail is extended in the same tick as the call, which is the whole mechanism. Awaiting before
 * extending it would let a second caller join the queue while the first is still suspended, and
 * both would then start from the same state. That is why the chaining below is not `await`.
 */
export class WriteQueue {
	private tail: Promise<unknown> = Promise.resolve();

	public add<T>(work: () => Promise<T>): Promise<T> {
		// oxlint-disable-next-line promise/prefer-await-to-then -- see the note above
		const done = this.tail.then(work);

		// A rejection is the caller's to handle; the queue only needs to keep moving.
		// oxlint-disable-next-line promise/prefer-await-to-then, eslint/no-empty-function
		this.tail = done.catch(() => {});

		return done;
	}
}
