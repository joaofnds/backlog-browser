import { rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

/*
 * `.catch` here is zod's, not a promise's: it is the value a field falls back to when the stored
 * one does not fit. `prefault` is the nearest alternative and is not the same, it rejects a
 * wrong-typed value rather than replacing it, which is the tolerance these files exist to provide.
 */
/* oxlint-disable promise/prefer-await-to-then */

const rootsEnvelope = z.object({
	roots: z.record(z.string(), z.unknown()).catch({}),
});

export function stateFile(name: string): string {
	const base = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");

	return join(base, "backlog-browser", name);
}

/**
 * Both state files hold one entry per root under a `roots` envelope, but each records a different
 * body, so each names the schema its own roots are read against. The bytes are parsed here, once,
 * and nothing downstream sees an unparsed value.
 *
 * A file that is missing, truncated or garbled reads as no roots recorded. A root whose body does
 * not fit is dropped and the rest are kept: these files are written by older versions and edited
 * by hand, and losing one remembered preference beats refusing to start.
 */
export async function readRoots<T>(
	file: string,
	root: z.ZodType<T>,
): Promise<Record<string, T>> {
	let document: unknown;
	try {
		document = await Bun.file(file).json();
	} catch {
		return {};
	}

	const envelope = rootsEnvelope.safeParse(document);
	if (!envelope.success) {
		return {};
	}

	return Object.fromEntries(
		Object.entries(envelope.data.roots).flatMap(([name, body]) => {
			const kept = root.safeParse(body);

			return kept.success ? [[name, kept.data] as const] : [];
		}),
	);
}

/**
 * Written beside and renamed over, so a crash mid-write cannot leave a half-written file. The pid
 * keeps two hubs from renaming each other's scratch out from underneath.
 */
export async function writeJson(file: string, value: unknown): Promise<void> {
	const scratch = `${file}.${process.pid}.tmp`;
	await Bun.write(scratch, `${JSON.stringify(value, null, 2)}\n`);
	await rename(scratch, file);
}
