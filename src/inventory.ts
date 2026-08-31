import { z } from "zod";

/**
 * What the hub answers when asked about its projects. Declared once, as a schema: the hub builds
 * these shapes and the shell and tests read them back, so both sides describe them the same way
 * and a change to one is a change to both.
 */
export const projectSummarySchema = z.object({
	slug: z.string(),
	name: z.string(),
	path: z.string(),
	hidden: z.boolean(),
	added: z.boolean(),
});

export const inventorySchema = z.object({
	root: z.string(),
	depth: z.number(),
	active: z.string().nullable(),
	mode: z.enum(["default", "manual"]),
	projects: z.array(projectSummarySchema),
});

/** What `/api/projects/:slug` answers: the shape depends on how far the child got. */
export const activationSchema = z.discriminatedUnion("status", [
	z.object({ status: z.literal("idle") }),
	z.object({ status: z.literal("starting") }),
	z.object({ status: z.literal("ready"), port: z.number(), url: z.string() }),
	z.object({
		status: z.literal("failed"),
		error: z.string(),
		stderr: z.string().optional(),
	}),
]);

/** Every project's status by slug, which the shell polls to keep its dots current. */
export const statusesSchema = z.record(z.string(), z.string());

export type ProjectSummary = Readonly<z.infer<typeof projectSummarySchema>>;

/** Deeply readonly: an inventory is read, never written back through. */
export interface Inventory {
	readonly root: string;
	readonly depth: number;
	readonly active: string | null;
	readonly mode: "default" | "manual";
	readonly projects: readonly ProjectSummary[];
}
export type ActivationReport = Readonly<z.infer<typeof activationSchema>>;

/** Anything a route answers with. Each shape is declared above; this is the set of them. */
export type Answer =
	| Inventory
	| ActivationReport
	| Readonly<Record<string, string>>
	| { readonly error: string }
	| { readonly kind: string; readonly path?: string };
