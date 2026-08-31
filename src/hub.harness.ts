import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type App, startApp } from "./app.ts";
import { FakeBacklog } from "./fake-backlog.ts";
import { FakeChooser } from "./fake-chooser.ts";
import { HubDriver } from "./hub.driver.ts";
import type { Project } from "./project.ts";
import { StateStore } from "./store.ts";
import type { Supervisor } from "./supervisor.ts";

/** Time the tests move by hand, so an idle sweep can be provoked without waiting for one. */
interface TestClock {
	now: number;
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
