import { z } from "zod";

import { SETTING_BOUNDS } from "./settings.ts";

const LOWEST_PORT = 1;
const HIGHEST_PORT = 65_535;

/**
 * The state file is written by older versions of this tool and edited by hand, so every field is
 * read as "what an earlier run may have left" rather than as a promise. A value that does not fit
 * falls back to the empty answer for its field: losing a remembered preference is a smaller harm
 * than refusing to start.
 *
 * `catch` is what expresses that per field, so one bad entry does not discard the rest.
 */
const port = z.number().int().min(LOWEST_PORT).max(HIGHEST_PORT);

const paths = z
	.array(z.unknown())
	.transform((entries) => entries.filter((entry) => typeof entry === "string"))
	.catch([]);

const storedRoot = z
	.object({
		active: z.string().min(1).nullable().catch(null),
		mode: z.enum(["default", "manual"]).catch("default"),
		order: paths,
		hidden: paths,
		added: paths,
		ports: z
			.record(z.string(), z.unknown())
			.transform((entries) =>
				Object.fromEntries(
					Object.entries(entries).flatMap(([path, value]) => {
						const kept = port.safeParse(value);

						return kept.success ? [[path, kept.data] as const] : [];
					}),
				),
			)
			.catch({}),
		settings: z
			.object({
				depth: z
					.number()
					.int()
					.min(SETTING_BOUNDS.depth.minimum)
					.max(SETTING_BOUNDS.depth.maximum)
					.nullable()
					.catch(null),
			})
			.catch({ depth: null }),
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

export type StoredRoot = z.infer<typeof storedRoot>;

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
