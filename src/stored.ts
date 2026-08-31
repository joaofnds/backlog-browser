import { z } from "zod";

import { SETTING_BOUNDS } from "./settings.ts";

const LOWEST_PORT = 1;
const HIGHEST_PORT = 65_535;

/**
 * The state file is written by older versions of this tool and edited by hand, so every field is
 * read as "what an earlier run may have left" rather than as a promise. A value that does not fit
 * falls back to the empty answer for its field, and one bad entry does not discard the rest:
 * losing a remembered preference is a smaller harm than refusing to start.
 */
function orElse<T>(schema: z.ZodType<T>, fallback: T): z.ZodType<T> {
	return z.union([schema, z.unknown().transform(() => fallback)]);
}

const port = z.number().int().min(LOWEST_PORT).max(HIGHEST_PORT);

const paths = orElse(
	z
		.array(z.unknown())
		.transform((entries) =>
			entries.filter((entry) => typeof entry === "string"),
		),
	[],
);

const ports = orElse(
	z.record(z.string(), z.unknown()).transform((entries) =>
		Object.fromEntries(
			Object.entries(entries).flatMap(([path, value]) => {
				const kept = port.safeParse(value);

				return kept.success ? [[path, kept.data] as const] : [];
			}),
		),
	),
	{},
);

const depth = orElse(
	z
		.number()
		.int()
		.min(SETTING_BOUNDS.depth.minimum)
		.max(SETTING_BOUNDS.depth.maximum)
		.nullable(),
	null,
);

const storedRoot = z
	.object({
		active: orElse(z.string().min(1).nullable(), null),
		mode: orElse(z.enum(["default", "manual"]), "default"),
		order: paths,
		hidden: paths,
		added: paths,
		ports,
		settings: orElse(z.object({ depth }), { depth: null }),
	})
	.partial()
	.transform((stored) => ({
		active: stored.active ?? null,
		mode: stored.mode ?? "default",
		order: stored.order ?? [],
		hidden: stored.hidden ?? [],
		added: stored.added ?? [],
		ports: stored.ports ?? {},
		settings: stored.settings ?? { depth: null },
	}));

/** The schema a root of `state.json` is read against. */
export const storedRootSchema = storedRoot;

/** What the file recorded. Read, never written back through, so it is readonly throughout. */
export interface StoredRoot {
	readonly active: string | null;
	readonly mode: "default" | "manual";
	readonly order: readonly string[];
	readonly hidden: readonly string[];
	readonly added: readonly string[];
	readonly ports: Readonly<Record<string, number>>;
	readonly settings: { readonly depth: number | null };
}

/** What a root that was never written looks like, so a first run reads the same as an empty one. */
export const EMPTY_ROOT: StoredRoot = {
	active: null,
	mode: "default",
	order: [],
	hidden: [],
	added: [],
	ports: {},
	settings: { depth: null },
};
