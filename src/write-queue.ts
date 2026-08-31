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
		const done = after(this.tail, work);
		this.tail = settled(done);

		return done;
	}
}

/** Runs `work` once `waitingOn` has finished, however it finished. */
async function after<T>(
	waitingOn: Promise<unknown>,
	work: () => Promise<T>,
): Promise<T> {
	await settled(waitingOn);

	return work();
}

/** Waits for a promise and swallows its rejection: the queue only needs to know it is over. */
async function settled(promise: Promise<unknown>): Promise<void> {
	try {
		await promise;
	} catch {
		// A rejection belongs to whoever asked for the work, not to the queue.
	}
}
