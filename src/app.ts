import type { FolderChooser } from "./choose-folder.ts";
import { ProjectRegistry } from "./registry.ts";
import { startHub } from "./server.ts";
import { DEFAULTS } from "./options.ts";
import { rememberedPorts } from "./remembered-ports.ts";
import type { StateStore } from "./store.ts";
import type { ChildLauncher, ReadinessProbe } from "./child.ts";
import { Supervisor } from "./supervisor.ts";

const IDLE_SWEEP_MS = 60_000;

export interface App {
	readonly server: Bun.Server<undefined>;
	readonly supervisor: Supervisor;
	readonly registry: ProjectRegistry;
	readonly store: StateStore;
	stop: () => Promise<void>;
}

/**
 * The one composition root. The CLI and the test harness both start the hub through here, so a
 * startup behavior the tests exercise is the behavior the tool runs.
 */
export async function startApp(
	options: {
		readonly root: string;
		readonly port: number;
		readonly depth: number | null;
		readonly idleTimeoutMs: number;
		readonly rescan: boolean;
	},
	deps: {
		readonly launch: ChildLauncher;
		readonly probe: ReadinessProbe;
		readonly allocate: (preferred: number) => Promise<number>;
		readonly chooseFolder: FolderChooser;
		readonly store: StateStore;
		readonly cacheFile: string;
		readonly readyTimeoutMs: number;
		readonly pollIntervalMs?: number;
		readonly now?: () => number;
	},
): Promise<App> {
	const { store } = deps;

	const remembered = await store.depth();
	const depth = options.depth ?? remembered ?? DEFAULTS.depth;
	if (options.depth !== null) {
		await store.rememberDepth(options.depth);
	}

	const registry = new ProjectRegistry({
		root: options.root,
		depth,
		file: deps.cacheFile,
	});
	await (options.rescan ? registry.refresh() : registry.load());
	const listed = await store.list();
	await registry.adopt(listed.added);

	const supervisor = new Supervisor({
		launch: deps.launch,
		probe: deps.probe,
		portFor: rememberedPorts({ store, allocate: deps.allocate }),
		idleTimeoutMs: options.idleTimeoutMs,
		readyTimeoutMs: deps.readyTimeoutMs,
		pollIntervalMs: deps.pollIntervalMs,
		now: deps.now,
	});

	const server = startHub({
		registry,
		store,
		supervisor,
		chooseFolder: deps.chooseFolder,
		port: options.port,
	});

	const sweep = setInterval(() => supervisor.stopIdle(), IDLE_SWEEP_MS);
	sweep.unref?.();

	return {
		server,
		supervisor,
		registry,
		store,
		stop: async () => {
			clearInterval(sweep);
			await supervisor.shutdown();
			await server.stop(true);
		},
	};
}
