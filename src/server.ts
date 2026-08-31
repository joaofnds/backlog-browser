import type { z } from "zod";

import type { FolderChooser } from "./choose-folder.ts";
import { readProject } from "./discovery.ts";
import type { ProjectRegistry } from "./registry.ts";
import type { ListedProject } from "./list.ts";
import shellHtml from "./shell/index.html" with { type: "text" };
import shellCss from "./shell/shell.css" with { type: "text" };
import shellJs from "./shell/shell.js" with { type: "text" };
import { SETTING_BOUNDS } from "./settings.ts";
import type { SettingBounds } from "./settings.ts";
import type { StateStore } from "./store.ts";
import { LOOPBACK } from "./child.ts";
import type { Supervisor } from "./supervisor.ts";
import {
	addedRequest,
	hiddenRequest,
	orderRequest,
	refreshRequest,
} from "./requests.ts";

export function startHub(options: {
	readonly registry: ProjectRegistry;
	readonly store: StateStore;
	readonly supervisor: Supervisor;
	readonly chooseFolder: FolderChooser;
	readonly port: number;
}): Bun.Server<undefined> {
	const { registry, store, supervisor, chooseFolder } = options;

	const server: Bun.Server<undefined> = Bun.serve({
		hostname: LOOPBACK,
		port: options.port,
		routes: guarded(() => server.url, {
			"/": asset(shellHtml, "text/html; charset=utf-8"),
			"/shell.css": asset(shellCss, "text/css; charset=utf-8"),
			"/shell.js": asset(shellJs, "text/javascript; charset=utf-8"),
			"/api/projects": async () => json(await inventoryOf(registry, store)),
			"/api/projects/:slug": (request) => {
				const project = registry.bySlug(request.params.slug);
				if (!project) {
					return json({ error: "unknown project" }, 404);
				}

				return json(supervisor.statusOf(project));
			},
			"/api/projects/:slug/activate": {
				POST: async (request) => {
					const project = registry.bySlug(request.params.slug);
					if (!project) {
						return json({ error: "unknown project" }, 404);
					}

					const activation = await supervisor.activate(project);
					await store.remember(project.slug);

					return json(activation);
				},
			},
			"/api/status": (request) => {
				const active = new URL(request.url).searchParams.get("active");
				const viewed = active === null ? undefined : registry.bySlug(active);
				if (viewed) {
					supervisor.touch(viewed);
				}

				return noStore(json(statusesOf(registry, supervisor)));
			},
			"/api/refresh": {
				POST: async (request) => {
					const asked = await parsed(request, refreshRequest);
					if (asked === null) {
						return json(
							{ error: outOfRange("depth", SETTING_BOUNDS.depth) },
							400,
						);
					}

					if (asked.depth !== undefined) {
						await store.rememberDepth(asked.depth);
					}
					await registry.refresh(asked.depth);

					return json(await inventoryOf(registry, store));
				},
			},
			"/api/choose-folder": {
				POST: async () => {
					const chosen = await chooseFolder({ startAt: registry.root });
					if (chosen.kind === "unavailable") {
						return json({ error: chosen.reason }, 501);
					}
					if (chosen.kind === "failed") {
						return json({ error: chosen.reason }, 500);
					}

					return noStore(json(chosen));
				},
			},
			"/api/list/added": {
				POST: async (request) => {
					const asked = await parsed(request, addedRequest);
					if (asked === null) {
						return json({ error: "path and added" }, 400);
					}

					if (asked.added && (await readProject(asked.path)) === null) {
						return json({ error: "no backlog/config.yml in that folder" }, 400);
					}

					const list = await store.updateList((current) =>
						asked.added ? current.add(asked.path) : current.drop(asked.path),
					);
					await registry.adopt(list.added);

					return json(await inventoryOf(registry, store));
				},
			},
			"/api/list/hidden": {
				POST: async (request) => {
					const asked = await parsed(request, hiddenRequest);
					if (asked === null) {
						return json({ error: "path and hidden" }, 400);
					}

					await store.updateList((list) =>
						asked.hidden ? list.hide(asked.path) : list.show(asked.path),
					);

					return json(await inventoryOf(registry, store));
				},
			},
			"/api/list/order": {
				POST: async (request) => {
					const asked = await parsed(request, orderRequest);
					if (asked === null) {
						return json({ error: "path and before" }, 400);
					}

					await store.updateList((list) =>
						list.move({
							path: asked.path,
							before: asked.before,
							discovered: registry.all(),
						}),
					);

					return json(await inventoryOf(registry, store));
				},
			},
			"/api/list/reset": {
				POST: async () => {
					await store.updateList((list) => list.reset());

					return json(await inventoryOf(registry, store));
				},
			},
		}),
		fetch: () => json({ error: "not found" }, 404),
	});

	return server;
}

type Handler<Path extends string> = (
	request: Bun.BunRequest<Path>,
) => Response | Promise<Response>;
type RouteValue<Path extends string> =
	| Handler<Path>
	| Record<string, Handler<Path>>;
type Routes<Paths extends string> = { [Path in Paths]: RouteValue<Path> };

interface ProjectSummary {
	slug: string;
	name: string;
	path: string;
	hidden: boolean;
	added: boolean;
}

interface Inventory {
	root: string;
	depth: number;
	active: string | null;
	mode: "default" | "manual";
	projects: ProjectSummary[];
}

/**
 * The hub listens on a known loopback port for as long as it runs, so every page the user visits
 * can reach it. Two headers separate the shell the hub served from everyone else:
 *
 * `Origin`, which a browser stamps on cross-site requests and a page cannot forge, keeps another
 * site from driving the routes that write state, spawn a child or open the host's chooser.
 *
 * `Host`, which pins the answer to the hub's own address. Binding to loopback does not settle
 * this: a name an attacker re-points at 127.0.0.1 is same-origin to the browser, and without this
 * check that page could read back the absolute path of every project on the machine.
 *
 * Both names for the loopback address are the hub's own, on its own port: the tool prints
 * `127.0.0.1` but `localhost` is what a user types, and refusing it would be a bug, not a defence.
 *
 * A request naming no host is refused rather than trusted. Every browser sends one, so nothing
 * legitimate is lost, and treating "absent" as "mine" let an HTTP/1.0 client walk straight past
 * the check. `Origin` stays optional: only a browser sets it, and curl is not the threat.
 */
function guarded<Paths extends string>(
	urlOf: () => URL,
	routes: Routes<Paths>,
): Routes<Paths> {
	const check = (request: Request): Response | null => {
		const { port } = urlOf();
		const own = new Set([`${LOOPBACK}:${port}`, `localhost:${port}`]);

		const host = request.headers.get("host")?.toLowerCase() ?? null;
		if (host === null || !own.has(host)) {
			return json({ error: "wrong host" }, 403);
		}

		const origin = request.headers.get("origin");
		if (origin !== null) {
			const named = hostOf(origin);
			if (named === null || !own.has(named)) {
				return json({ error: "wrong origin" }, 403);
			}
		}

		return null;
	};

	const wrap =
		<Path extends Paths>(handler: Handler<Path>): Handler<Path> =>
		(request) =>
			check(request) ?? handler(request);

	/** A route is either one handler or a handler per method; both are wrapped the same way. */
	const guard = <Path extends Paths>(
		route: RouteValue<Path>,
	): RouteValue<Path> =>
		typeof route === "function"
			? wrap(route)
			: Object.fromEntries(
					Object.entries(route).map(([method, handler]) => [
						method,
						wrap(handler),
					]),
				);

	const wrapped: Routes<Paths> = { ...routes };
	for (const path of keysOf(wrapped)) {
		wrapped[path] = guard(wrapped[path]);
	}

	return wrapped;
}

/**
 * The keys of an object whose key type is known. `Object.keys` widens them to `string`, which
 * would lose the path each route is declared under and with it the params it can name.
 */
function keysOf<Paths extends string>(routes: Routes<Paths>): Paths[] {
	const keys: Paths[] = [];
	for (const key in routes) {
		if (Object.hasOwn(routes, key)) {
			keys.push(key);
		}
	}

	return keys;
}

/**
 * The `host:port` an origin names, or the header itself when it names none. `null` for the opaque
 * origin a sandboxed frame sends, and the scheme is part of the answer: the hub speaks http, so an
 * `https://localhost:<port>` origin is a different origin and must not match.
 */
function hostOf(origin: string): string | null {
	try {
		const url = new URL(origin);

		return url.protocol === "http:" ? url.host.toLowerCase() : null;
	} catch {
		return null;
	}
}

async function inventoryOf(
	registry: ProjectRegistry,
	store: StateStore,
): Promise<Inventory> {
	const list = await store.list();
	const kept = keptByHand(list.added, registry.walked());

	return {
		root: registry.root,
		depth: registry.depth,
		active: await store.lastActive(),
		mode: list.mode,
		projects: list
			.arrange(registry.all())
			.map((listed) => describe(listed, kept)),
	};
}

/**
 * A path the user added and a later walk then reached is an ordinary discovered project: dropping
 * it from the added set would not remove it, so the shell must not offer to.
 */
function keptByHand(
	added: readonly string[],
	walked: ReadonlySet<string>,
): ReadonlySet<string> {
	return new Set(added.filter((path) => !walked.has(path)));
}

function outOfRange(field: string, bounds: SettingBounds): string {
	return `${field} must be a whole number between ${bounds.minimum} and ${bounds.maximum}`;
}

function statusesOf(
	registry: ProjectRegistry,
	supervisor: Supervisor,
): Record<string, string> {
	return Object.fromEntries(
		registry
			.all()
			.map((project) => [project.slug, supervisor.statusOf(project).status]),
	);
}

function describe(
	listed: ListedProject,
	kept: ReadonlySet<string>,
): ProjectSummary {
	return {
		slug: listed.project.slug,
		name: listed.project.name,
		path: listed.project.path,
		hidden: listed.hidden,
		added: kept.has(listed.project.path),
	};
}

/**
 * The body a route accepts, or `null` when the request did not send one. Parsing here is what lets
 * a handler work with a value its schema already vouched for, instead of re-checking each field.
 */
async function parsed<Body>(
	request: Bun.BunRequest,
	schema: z.ZodType<Body>,
): Promise<Body | null> {
	const body: unknown = await request.json().catch(() => null);
	const asked = schema.safeParse(body);

	return asked.success ? asked.data : null;
}

/** A handler rather than a bare `Response`, so the guard sees every request for the shell too. */
function asset(body: string, contentType: string): () => Response {
	return () =>
		new Response(body, {
			headers: { "content-type": contentType, "cache-control": "no-store" },
		});
}

function noStore(response: Response): Response {
	response.headers.set("cache-control", "no-store");

	return response;
}

function json(body: unknown, status = 200): Response {
	return Response.json(body, { status });
}
