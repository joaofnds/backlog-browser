import { mkdtemp, realpath, rm } from "node:fs/promises";
import { connect } from "node:net";

import { z } from "zod";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startApp } from "./app.ts";
import type { App } from "./app.ts";
import type { ChosenFolder } from "./choose-folder.ts";
import type { Project } from "./project.ts";
import { StateStore } from "./store.ts";
import { FakeBacklog } from "./fake-backlog.ts";
import type { Supervisor } from "./supervisor.ts";

/** Stands in for the host's chooser: the tests say what the user chose, no window involved. */
export class FakeChooser {
	public readonly openedAt: string[] = [];
	private answer: ChosenFolder = { kind: "cancelled" };

	public chooses(path: string): void {
		this.answer = { kind: "chosen", path };
	}

	public cancels(): void {
		this.answer = { kind: "cancelled" };
	}

	public breaks(reason: string): void {
		this.answer = { kind: "unavailable", reason };
	}

	public fails(reason: string): void {
		this.answer = { kind: "failed", reason };
	}

	public choose = ({
		startAt,
	}: {
		readonly startAt: string;
	}): Promise<ChosenFolder> => {
		this.openedAt.push(startAt);

		return Promise.resolve(this.answer);
	};
}

/** Time the tests move by hand, so an idle sweep can be provoked without waiting for one. */
interface TestClock {
	now: number;
}

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
		const raw = await new Promise<string>((resolve, reject) => {
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
				resolve(answer);
			});
			socket.on("error", reject);
		});

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

export class HubHarness {
	private constructor(
		public readonly root: string,
		private readonly app: App,
		public readonly backlog: FakeBacklog,
		public readonly chooser: FakeChooser,
		public readonly clock: TestClock,
	) {}

	/** Boots through `startApp`, the same composition root the CLI uses, with the Fakes as deps. */
	public static async start(
		options: {
			readonly depth?: number;
			readonly root?: string;
			readonly rescan?: boolean;
			readonly idleTimeoutMs?: number;
		} = {},
	): Promise<HubHarness> {
		// Real path, not the `/var` symlink macOS hands back: a project is named by its real
		// directory, so the root has to be one too for the two to compare equal.
		const root =
			options.root ??
			(await realpath(await mkdtemp(join(tmpdir(), "backlog-browser-"))));
		const backlog = new FakeBacklog();
		const chooser = new FakeChooser();
		const clock = { now: 0 };

		const app = await startApp(
			{
				root,
				port: 0,
				depth: options.depth ?? null,
				idleTimeoutMs: options.idleTimeoutMs ?? 0,
				rescan: options.rescan ?? false,
			},
			{
				launch: backlog.launch,
				probe: backlog.probe,
				allocate: backlog.allocatePort,
				chooseFolder: chooser.choose,
				store: new StateStore({
					file: join(root, ".state", "state.json"),
					root,
				}),
				cacheFile: join(root, ".state", "discovery.json"),
				readyTimeoutMs: 1000,
				pollIntervalMs: 0,
				now: () => clock.now,
			},
		);

		return new HubHarness(root, app, backlog, chooser, clock);
	}

	public get store(): StateStore {
		return this.app.store;
	}

	public get supervisor(): Supervisor {
		return this.app.supervisor;
	}

	public projectFor(slug: string): Project {
		const project = this.app.registry.find(slug);
		if (!project) {
			throw new Error(`no discovered project with slug ${slug}`);
		}

		return project;
	}

	public driver(): HubDriver {
		return new HubDriver(this.app.server.url.origin);
	}

	public async addProject(name: string, directory = name): Promise<string> {
		const path = join(this.root, directory);
		await Bun.write(
			join(path, "backlog", "config.yml"),
			`project_name: "${name}"\n`,
		);

		return path;
	}

	/**
	 * A second hub over the same root, so the same `state.json` and discovery cache carry over. The
	 * child ports do not: a fresh `FakeBacklog` counts from the bottom again, which is what makes a
	 * project landing on its old port evidence that the port was remembered rather than re-derived.
	 */
	public async restart(
		options: {
			readonly depth?: number;
			readonly rescan?: boolean;
			readonly idleTimeoutMs?: number;
		} = {},
	): Promise<HubHarness> {
		await this.app.stop();

		return HubHarness.start({ ...options, root: this.root });
	}

	public async stop(): Promise<void> {
		await this.app.stop();
		await rm(this.root, { recursive: true, force: true });
	}
}

/**
 * The hub's own routes answer with the shapes declared above, and the tests assert on those
 * shapes rather than on the parse. SAFETY: the one place the untyped body is named, so a
 * response shape that drifts is a failure in the test that reads it.
 */
async function read<T>(
	schema: z.ZodType<T>,
	answering: Promise<Response>,
): Promise<T> {
	const response = await answering;

	return schema.parse(await response.json());
}
