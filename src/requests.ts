import { resolve } from "node:path";

import { z } from "zod";

import { SETTING_BOUNDS } from "./settings.ts";

/**
 * Every request body the hub accepts, parsed once where it arrives. A route never sees a field it
 * has to narrow itself, so an illegal body is a 400 at the door rather than a shape each handler
 * has to keep re-checking.
 */

/**
 * One directory is one project, and a slug is derived from its path, so a path is resolved before
 * anything is keyed by it: two spellings of the same directory would otherwise list it twice and
 * let a removal drop only the spelling it was given.
 */
const projectPath = z
	.string()
	.min(1)
	.transform((path) => resolve(path));

/** The project a move puts this one in front of, or `null` for the end of the list. */
const anchor = z.string().min(1).nullable();

export const refreshRequest = z.object({
	depth: z
		.number()
		.int()
		.min(SETTING_BOUNDS.depth.minimum)
		.max(SETTING_BOUNDS.depth.maximum)
		.optional(),
});

export const addedRequest = z.object({
	path: projectPath,
	added: z.boolean(),
});

export const hiddenRequest = z.object({
	path: projectPath,
	hidden: z.boolean(),
});

export const orderRequest = z.object({
	path: projectPath,
	before: anchor,
});

export type RefreshRequest = z.infer<typeof refreshRequest>;
export type AddedRequest = z.infer<typeof addedRequest>;
export type HiddenRequest = z.infer<typeof hiddenRequest>;
export type OrderRequest = z.infer<typeof orderRequest>;
