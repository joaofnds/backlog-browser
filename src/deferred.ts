/**
 * A promise settled by someone other than the work that produced it.
 *
 * `async`/`await` cannot express this: it ties settling to a function returning, and these cases
 * settle from elsewhere entirely — a child process exiting, a socket closing, a test releasing a
 * value it was holding back. Naming the shape once keeps the raw constructor out of the code that
 * uses it.
 */
export interface Deferred<T> {
	readonly promise: Promise<T>;
	readonly settle: (value: T) => void;
	readonly fail: (reason: Readonly<Error>) => void;
}

export function deferred<T>(): Deferred<T> {
	const { promise, resolve, reject } = Promise.withResolvers<T>();

	return { promise, settle: resolve, fail: reject };
}
