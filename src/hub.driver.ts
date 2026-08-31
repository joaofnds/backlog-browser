import { connect } from "node:net";

import { z } from "zod";

import { deferred } from "./deferred.ts";

/**
 * The shapes the hub answers with. The tests parse against these rather than asserting, so a
 * response that drifts fails in the driver, naming the field, instead of somewhere downstream.
 */
const projectSummary = z.object({
	slug: z.string(),
	name: z.string(),
	path: z.string(),
	hidden: z.boolean(),
	added: z.boolean(),
});

export type ProjectSummary = z.infer<typeof projectSummary>;
const inventory = z.object({
	root: z.string(),
	depth: z.number(),
	active: z.string().nullable(),
	mode: z.enum(["default", "manual"]),
	projects: z.array(projectSummary),
});

export type Inventory = z.infer<typeof inventory>;

const statuses = z.record(z.string(), z.string());

/** What `/api/projects/:slug` answers: the shape depends on how far the child got. */
const activation = z.discriminatedUnion("status", [
	z.object({ status: z.literal("idle") }),
	z.object({ status: z.literal("starting") }),
	z.object({
		status: z.literal("ready"),
		port: z.number(),
		url: z.string(),
	}),
	z.object({
		status: z.literal("failed"),
		error: z.string(),
		stderr: z.string().optional(),
	}),
]);

export type ActivationReport = z.infer<typeof activation>;

export class HubDriver {
	public constructor(public readonly origin: string) {}

	public get(path: string): Promise<Response> {
		return fetch(`${this.origin}${path}`);
	}

	public projects(): Promise<Inventory> {
		return read(inventory, this.get("/api/projects"));
	}

	public refresh(depth?: number): Promise<Inventory> {
		return read(inventory, this.refreshing(depth));
	}

	public refreshing(depth?: number): Promise<Response> {
		return this.post("/api/refresh", depth === undefined ? {} : { depth });
	}

	public chooseFolder(): Promise<Response> {
		return this.post("/api/choose-folder", {});
	}

	/** Adds a path and reads the inventory back, which is what most callers want from it. */
	public adding(path: string): Promise<Inventory> {
		return read(inventory, this.addPath(path));
	}

	public addPath(path: string): Promise<Response> {
		return this.post("/api/list/added", { path, added: true });
	}

	/** Drops a path and reads the inventory back, the mirror of `adding`. */
	public dropping(path: string): Promise<Inventory> {
		return read(inventory, this.dropPath(path));
	}

	public dropPath(path: string): Promise<Response> {
		return this.post("/api/list/added", { path, added: false });
	}

	public activate(slug: string): Promise<Response> {
		return fetch(`${this.origin}/api/projects/${slug}/activate`, {
			method: "POST",
		});
	}

	public statuses(): Promise<Record<string, string>> {
		return read(statuses, this.get("/api/status"));
	}

	/** The status as the shell reads it, parsed, for a test that looks past the status word. */
	public reported(slug: string): Promise<ActivationReport> {
		return read(activation, this.status(slug));
	}

	public status(slug: string): Promise<Response> {
		return this.get(`/api/projects/${slug}`);
	}

	public post(path: string, body: unknown): Promise<Response> {
		return fetch(`${this.origin}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	/** A request as another site's page would send it: the browser stamps its own origin on. */
	public postFrom(
		origin: string,
		path: string,
		body: unknown,
	): Promise<Response> {
		return fetch(`${this.origin}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json", origin },
			body: JSON.stringify(body),
		});
	}

	/** A request reaching the hub under a rebound name rather than its own loopback host. */
	public getAs(host: string, path: string): Promise<Response> {
		return fetch(`${this.origin}${path}`, { headers: { host } });
	}

	/**
	 * A request naming no host at all, which `fetch` cannot express: it always sends one. Only a
	 * raw client can, so this speaks HTTP/1.0 down a socket and reads the status line back.
	 */
	public async hostless(path: string): Promise<Response> {
		const url = new URL(this.origin);
		const answered = deferred<string>();
		const socket = connect(
			{ host: url.hostname, port: Number(url.port) },
			() => {
				socket.write(`GET ${path} HTTP/1.0\r\n\r\n`);
			},
		);

		let answer = "";
		socket.setEncoding("utf8");
		socket.on("data", (chunk) => {
			answer += String(chunk);
		});
		socket.on("end", () => {
			answered.settle(answer);
		});
		socket.on("error", answered.fail);

		const raw = await answered.promise;
		const [head, body = ""] = raw.split("\r\n\r\n");
		const status = Number(head?.split(" ")[1] ?? 0);

		return new Response(body, { status });
	}

	public hide(path: string): Promise<Inventory> {
		return read(
			inventory,
			this.post("/api/list/hidden", { path, hidden: true }),
		);
	}

	public show(path: string): Promise<Inventory> {
		return read(
			inventory,
			this.post("/api/list/hidden", { path, hidden: false }),
		);
	}

	public move(path: string, before: string | null): Promise<Inventory> {
		return read(inventory, this.post("/api/list/order", { path, before }));
	}

	public resetOrder(): Promise<Inventory> {
		return read(inventory, this.post("/api/list/reset", {}));
	}
}

async function read<T>(
	schema: z.ZodType<T>,
	answering: Promise<Response>,
): Promise<T> {
	const response = await answering;

	return schema.parse(await response.json());
}
